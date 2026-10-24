import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryKube } from '../helpers/InMemoryKube.js';
import { startIntegration, type Integration } from '../helpers/integration.js';

/** Dev Spaces cluster (001d) and a separate build/deploy cluster (004d), as in the original design. */
let t: Integration;
let deploy: InMemoryKube;

beforeAll(async () => {
  deploy = new InMemoryKube();
  t = await startIntegration({}, { deployKube: deploy });
});
afterAll(() => t.close());

describe('workspaces stay on the Dev Spaces cluster, deployment projects go to the deploy cluster', () => {
  it('creates the deployment project (and its quotas, roles, bindings) only on the deploy cluster', async () => {
    const res = await t.api('post', '/api/v1/pp1/deployment-projects').send({ csiid: '1001' });
    expect(res.status).toBe(201);

    expect(deploy.namespaces.has('pp1-devspaces-deploy-1001')).toBe(true);
    expect([...deploy.objects.keys()].some((k) => k.startsWith('Role/pp1-devspaces-deploy-1001/'))).toBe(
      true,
    );
    expect(t.fakes.kube.namespaces.size).toBe(0);
    expect(t.fakes.kube.objects.size).toBe(0);
  });

  it('lists and deletes them on the deploy cluster', async () => {
    expect((await t.api('get', '/api/v1/pp1/deployment-projects')).body).toEqual([
      'pp1-devspaces-deploy-1001',
    ]);
    const res = await t.api('delete', '/api/v1/pp1/deployment-projects');
    expect(res.body.deleted).toEqual(['pp1-devspaces-deploy-1001']);
    expect(deploy.namespaces.size).toBe(0);
  });

  it('workspaces and projects are created on the Dev Spaces cluster, never on the deploy cluster', async () => {
    const res = await t
      .api('post', '/api/v1/pp1/workspaces')
      .send({ devworkspaceValue: 'java-maven', csiid: '1001' });
    expect(res.status).toBe(200);
    expect(t.fakes.kube.workspaces('pp1-devspaces-1001')).toHaveLength(1);
    expect(deploy.namespaces.size).toBe(0);
    expect(deploy.objects.size).toBe(0);
  });

  it('personal access tokens and git config also belong to the Dev Spaces cluster', async () => {
    const pat = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
    expect((await t.api('post', '/api/v1/pp1/pats/main').send({ csiid: '1001', token: pat })).status).toBe(
      201,
    );
    expect(
      (await t.api('put', '/api/v1/pp1/gitconfig').send({ csiid: '1001', content: '[user]\n  name = P\n' }))
        .status,
    ).toBe(200);
    expect(deploy.objects.size).toBe(0);
  });
});

describe('readiness checks both clusters when they are different', () => {
  it('reports each cluster', async () => {
    const res = await request(t.app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ kubernetes: 'ok', deployCluster: 'ok', postgres: 'ok' });
  });

  it('is not ready when only the deploy cluster is down', async () => {
    deploy.failOnce('ping', new Error('deploy cluster unreachable'));
    const res = await request(t.app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ kubernetes: 'ok', deployCluster: 'unavailable', postgres: 'ok' });
  });

  it('is not ready when only the Dev Spaces cluster is down', async () => {
    t.fakes.kube.failOnce('ping', new Error('dev spaces cluster unreachable'));
    const res = await request(t.app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ kubernetes: 'unavailable', deployCluster: 'ok', postgres: 'ok' });
  });
});

describe('with a single cluster (the default, as in the team’s current environment)', () => {
  it('uses the same cluster for deployment projects and reports one cluster check', async () => {
    const single = await startIntegration();
    try {
      expect(single.container.deployKube).toBe(single.container.kube);
      expect((await single.api('post', '/api/v1/pp1/deployment-projects').send({ csiid: '5' })).status).toBe(
        201,
      );
      expect(single.fakes.kube.namespaces.has('pp1-devspaces-deploy-5')).toBe(true);
      const ready = await request(single.app).get('/readyz');
      expect(ready.body.checks).toEqual({ kubernetes: 'ok', postgres: 'ok' });
    } finally {
      await single.close();
    }
  });
});
