import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIntegration, type Integration } from '../helpers/integration.js';
import { InMemoryKube } from '../helpers/InMemoryKube.js';
import { signToken } from '../../src/http/auth.js';

let t: Integration;
let deploy: InMemoryKube;
beforeEach(async () => {
  deploy = new InMemoryKube();
  t = await startIntegration({}, { deployKube: deploy });
});
afterEach(async () => {
  await t.close();
});

describe('versioned provisioning and discovery', () => {
  it('creates workspace projects idempotently and filters by CSI id', async () => {
    expect((await t.api('post', '/api/v1/pp1/projects').send({ csiid: '1001' })).status).toBe(201);
    expect((await t.api('post', '/api/v1/pp1/projects').send({ csiid: '1001' })).status).toBe(200);
    await t.api('post', '/api/v1/pp1/projects').send({ csiid: '1002' });
    const projects = await t.api('get', '/api/v1/pp1/projects?csiid=1002');
    expect(projects.body).toHaveLength(1);
    expect(projects.body[0].csiid).toBe('1002');
    expect((await t.api('get', '/api/v1/pp1/projects?csiid=bad')).status).toBe(400);
    expect((await t.api('get', '/api/v1/pp1/stacks')).status).toBe(404);
    expect((await t.api('get', '/api/v1/pp1/workspaces?csiid=1001')).body).toEqual([]);
  });
  it('filters deployment projects on the correct cluster', async () => {
    await t.api('post', '/api/v1/pp1/deployment-projects').send({ csiid: '1001' });
    await t.api('post', '/api/v1/pp1/deployment-projects').send({ csiid: '1002' });
    expect((await t.api('get', '/api/v1/pp1/deployment-projects?csiid=1001')).body).toEqual([
      'pp1-devspaces-deploy-1001',
    ]);
    expect(await t.fakes.kube.getNamespace('pp1-devspaces-deploy-1001')).toBeNull();
  });
});

describe('support resources', () => {
  it.each(['workspace', 'deployment'])('repairs defaults and applies custom quotas on %s', async (target) => {
    await t
      .api('post', `/api/v1/pp1/${target === 'workspace' ? 'projects' : 'deployment-projects'}`)
      .send({ csiid: '1001' });
    const body = { soeid: 'pp1', csiid: '1001', target };
    expect((await t.api('put', '/api/v1/support/resources').send(body)).status).toBe(200);
    const response = await t.api('put', '/api/v1/support/resources').send({
      ...body,
      resources: [
        { kind: 'ResourceQuota', metadata: { name: 'custom-quota' }, spec: { hard: { pods: '4' } } },
      ],
    });
    expect(response.status).toBe(200);
    const kube = target === 'workspace' ? t.fakes.kube : deploy;
    expect(await kube.get('ResourceQuota', response.body.namespace, 'custom-quota')).toMatchObject({
      spec: { hard: { pods: '4' } },
    });
  });
  it('rejects missing projects and namespace ownership mismatches', async () => {
    const body = { soeid: 'pp1', csiid: '1001', target: 'deployment' };
    expect((await t.api('put', '/api/v1/support/resources').send(body)).status).toBe(404);
    deploy.seedNamespace('pp1-devspaces-deploy-1001', 'pp2', '1001');
    expect((await t.api('put', '/api/v1/support/resources').send(body)).status).toBe(409);
  });
  it('routes cluster roles to the selected cluster', async () => {
    deploy.seedNamespace('pp1-devspaces-deploy-1001', 'pp1', '1001');
    const apply = vi.fn(async (_kind, body) => body);
    t.container.deployKube.applyCluster = apply;
    const resource = { kind: 'ClusterRole', metadata: { name: 'support-reader' }, rules: [] };
    expect(
      (
        await t
          .api('put', '/api/v1/support/resources')
          .send({ soeid: 'pp1', csiid: '1001', target: 'deployment', resources: [resource] })
      ).status,
    ).toBe(200);
    expect(apply).toHaveBeenCalledWith('ClusterRole', resource);
  });
  it('rejects invalid resource kinds', async () => {
    expect(
      (
        await t.api('put', '/api/v1/support/resources').send({
          soeid: 'pp1',
          csiid: '1001',
          target: 'workspace',
          resources: [{ kind: 'Secret', metadata: { name: 'token' } }],
        })
      ).status,
    ).toBe(400);
  });
});

describe('runtime configuration', () => {
  const patch = (body: object) =>
    request(t.app).patch('/api/v1/configuration').set('Authorization', `Bearer ${t.token}`).send(body);
  it('validates updates atomically, redacts secrets and keeps repeated changes active', async () => {
    expect(
      (await patch({ MAX_RUNNING_WORKSPACES: 1, NOTIFICATION_EMAIL_PASSWORD: 'private-value' })).status,
    ).toBe(200);
    expect((await patch({ MAX_TOTAL_WORKSPACES: 8 })).status).toBe(200);
    expect((await patch({ MAX_RUNNING_WORKSPACES: 9 })).status).toBe(400);
    expect((await patch({ SECRET_KEY: 'overwrite' })).status).toBe(400);
    const response = await t.api('get', '/api/v1/configuration');
    expect(response.body.settings).toMatchObject({
      MAX_RUNNING_WORKSPACES: 1,
      MAX_TOTAL_WORKSPACES: 8,
      NOTIFICATION_EMAIL_PASSWORD: '[redacted]',
    });
    expect(JSON.stringify(response.body)).not.toContain('private-value');
    expect(t.container.config.limits.maxRunning).toBe(1);
  });
  it('requires new credentials when a cluster URL changes', async () => {
    expect((await patch({ CLUSTER_API_URL: 'https://other.test' })).status).toBe(400);
    expect(
      (await patch({ CLUSTER_API_URL: 'https://api.other.test', CLUSTER_TOKEN: 'new-token' })).status,
    ).toBe(200);
    expect(t.container.config.cluster.deployApiUrl).toBe('https://api.other.test');
  });
  it('changes notification, registry, deployment cluster and limits together', async () => {
    const response = await patch({
      DEVREG_URL: 'https://registry.other.test',
      NOTIFICATION_MAIL_URL: 'https://mail.test',
      NOTIFICATION_EMAIL_USERNAME: 'mail-user',
      DEPLOY_CLUSTER_API_URL: 'https://deploy.test',
      DEPLOY_CLUSTER_TOKEN: 'deploy-token',
      MAX_TOTAL_WORKSPACES: 9,
    });
    expect(response.status).toBe(200);
    expect(t.container.config.notification.username).toBe('mail-user');
    expect(t.container.config.devreg.url).toBe('https://registry.other.test');
  });
});

describe('administrative access', () => {
  it.each(['/configuration', '/logs', '/support/resources'])(
    'rejects anonymous and regular users at %s',
    async (path) => {
      const token = signToken(t.container.config.auth, { soeid: 'pp1', role: 'user' });
      expect((await request(t.app).get(`/api/v1${path}`)).status).toBe(401);
      expect(
        (await request(t.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`)).status,
      ).toBe(403);
    },
  );
  it('serves bounded log results in JSON and readable text', async () => {
    expect((await t.api('get', '/api/v1/logs?days=2&format=text')).text).toContain('Application logs |');
    expect((await t.api('get', '/api/v1/logs?days=32')).status).toBe(400);
    expect((await t.api('get', '/api/v1/logs?days=1&limit=1')).body.entries.length).toBeLessThanOrEqual(1);
  });
});
