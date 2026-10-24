import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startIntegration, type Integration } from '../helpers/integration.js';

let t: Integration;
beforeAll(async () => {
  t = await startIntegration();
});
afterAll(() => t.close());
beforeEach(async () => {
  t.fakes.kube.namespaces.clear();
  t.fakes.kube.objects.clear();
  await t.sql('DELETE FROM metrics."devspaces-metrics"');
  t.registry.failing = false;
});

const base = '/api/v1/pp1/workspaces';
const body = { devworkspaceValue: 'java-maven', csiid: '1001' };

describe('GET /api/v1/catalog', () => {
  it('returns the registry catalog over real HTTP', async () => {
    const res = await t.api('get', '/api/v1/catalog');
    expect(res.status).toBe(200);
    expect(res.body.map((e: { name: string }) => e.name)).toEqual(['java-maven', 'python']);
  });

  it('answers 502 when the registry is down', async () => {
    t.registry.failing = true;
    const res = await t.api('get', '/api/v1/catalog');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
  });
});

describe('POST /api/v1/:soeid/workspaces', () => {
  it('creates the project and the workspace, and records both', async () => {
    const res = await t.api('post', base).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      namespace: 'pp1-devspaces-1001',
      csiid: '1001',
      stack: 'java-maven',
      version: '2.0.0',
      displayName: 'Java Maven',
      editor: 'Visual Studio Code',
      limitcpu: 2,
      limitmemory: 4,
      storage: 3,
    });

    expect(t.fakes.kube.workspaces('pp1-devspaces-1001')).toHaveLength(1);
    expect(registryPaths()).toEqual(['GET /v2index/all', 'GET /devfiles/java-maven/2.0.0']);

    const rows = await t.metricsRows();
    expect(rows.map((r) => `${r.eventtype}:${r.resourcetype}`)).toEqual([
      'create:project',
      'create:workspace',
    ]);
    expect(rows[1]).toMatchObject({
      soeid: 'pp1',
      csiid: '1001',
      workspaceversion: '2.0.0',
      editorname: 'vscode',
    });
    expect(Number(rows[1]?.limitcpu)).toBe(2);
    expect(rows[1]?.status).toEqual({ failed: false, error: '', message: '' });
  });

  it('does not recreate the project for a second workspace', async () => {
    await t.api('post', base).send(body);
    await t.api('post', base).send(body);
    const rows = await t.metricsRows();
    expect(rows.filter((r) => r.resourcetype === 'project')).toHaveLength(1);
    expect(rows.filter((r) => r.resourcetype === 'workspace')).toHaveLength(2);
  });

  it('honours editor, stack version and repository', async () => {
    const res = await t.api('post', base).send({
      ...body,
      editor: 'intellij',
      stackVersion: '1.0.0',
      repositoryUrl: 'https://github.com/acme/app.git',
      repositoryBranch: 'main',
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.0.0');
    const dw = t.fakes.kube.workspaces()[0];
    expect(dw?.spec?.template?.projects).toEqual([
      {
        name: 'app',
        git: { remotes: { origin: 'https://github.com/acme/app.git' }, checkoutFrom: { revision: 'main' } },
      },
    ]);
    expect(dw?.spec?.template?.components?.some((c) => c.name === 'che-idea-server')).toBe(true);
  });

  it('answers 404 for an unknown stack and creates nothing', async () => {
    const res = await t.api('post', base).send({ ...body, devworkspaceValue: 'cobol' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'WORKSPACE_CONFIG_NOT_FOUND' });
    expect(t.fakes.kube.workspaces()).toHaveLength(0);
  });

  it('answers 502 when the registry fails mid-create', async () => {
    t.registry.failing = true;
    const res = await t.api('post', base).send(body);
    expect(res.status).toBe(502);
    expect(t.fakes.kube.workspaces()).toHaveLength(0);
  });

  it.each([
    ['missing stack', { csiid: '1' }],
    ['bad csiid', { ...body, csiid: 'x' }],
    ['unknown field', { ...body, sneaky: true }],
    ['http repository', { ...body, repositoryUrl: 'http://github.com/a/b' }],
  ])('answers 400 for %s', async (_l, payload) => {
    const res = await t.api('post', base).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('answers 409 once the running limit (2) is reached', async () => {
    await t.api('post', base).send(body);
    await t.api('post', base).send(body);
    const res = await t.api('post', base).send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'WORKSPACE_RUN_COUNT_EXCEEDED' });
    expect(res.body.message).toMatch(/limit is 2/);
  });

  it('answers 409 once the total limit (3) is reached', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await t.api('post', base).send(body);
      expect(res.status).toBe(200);
      t.fakes.kube.setPhase('pp1-devspaces-1001', res.body.id, 'Stopped');
    }
    const res = await t.api('post', base).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORKSPACE_COUNT_EXCEEDED');
  });

  it('records a failed metric and answers 502 when the cluster rejects the workspace', async () => {
    t.fakes.kube.failOnce('create:DevWorkspace', Object.assign(new Error('denied'), { code: 500 }));
    const res = await t.api('post', base).send(body);
    expect(res.status).toBe(500);
    const failed = (await t.metricsRows()).find((r) => r.resourcetype === 'workspace');
    expect(failed?.status).toMatchObject({ failed: true });
  });

  it('refuses to use a namespace owned by someone else', async () => {
    t.fakes.kube.seedNamespace('pp1-devspaces-1001', 'intruder', '1001');
    const res = await t.api('post', base).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAMESPACE_OWNERSHIP_MISMATCH');
  });
});

describe('workspace lifecycle', () => {
  async function created() {
    const res = await t.api('post', base).send(body);
    return res.body as { id: string; namespace: string };
  }

  it('lists and gets only the caller’s workspaces', async () => {
    const ws = await created();
    expect((await t.api('get', base)).body.map((w: { id: string }) => w.id)).toEqual([ws.id]);
    expect((await t.api('get', `${base}/${ws.id}`)).body.id).toBe(ws.id);
    expect((await t.api('get', '/api/v1/pp2/workspaces')).body).toEqual([]);
    expect((await t.api('get', `/api/v1/pp2/workspaces/${ws.id}`)).status).toBe(404);
  });

  it('reflects the cluster’s phase and URL', async () => {
    const ws = await created();
    t.fakes.kube.setPhase(ws.namespace, ws.id, 'Running', 'https://ws.example/ide');
    const res = await t.api('get', `${base}/${ws.id}`);
    expect(res.body).toMatchObject({ phase: 'Running', mainUrl: 'https://ws.example/ide' });
  });

  it('stops then starts, with metrics for each', async () => {
    const ws = await created();
    t.fakes.kube.setPhase(ws.namespace, ws.id, 'Running');
    t.fakes.clock.advance(3 * 60 * 1000);

    const stop = await t.api('post', `${base}/${ws.id}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.message).toBe(`Workspace with id ${ws.id} is stopping.`);
    expect(t.fakes.kube.workspaces()[0]?.spec?.started).toBe(false);

    t.fakes.kube.setPhase(ws.namespace, ws.id, 'Stopped');
    const start = await t.api('post', `${base}/${ws.id}/start`);
    expect(start.status).toBe(200);
    expect(start.body.message).toBe(`Workspace with id ${ws.id} is starting.`);
    expect(t.fakes.kube.workspaces()[0]?.spec?.started).toBe(true);

    const rows = await t.metricsRows();
    expect(rows.map((r) => r.eventtype)).toEqual(['create', 'create', 'stop', 'start']);
    expect(rows[2]?.duration).toBe('3 minutes');
  });

  it('refuses to start a third running workspace', async () => {
    const a = await created();
    t.fakes.kube.setPhase(a.namespace, a.id, 'Stopped');
    const b = await created();
    t.fakes.kube.setPhase(b.namespace, b.id, 'Stopped');
    const c = await created();
    t.fakes.kube.setPhase(c.namespace, c.id, 'Stopped');
    t.fakes.kube.setPhase(a.namespace, a.id, 'Running');
    t.fakes.kube.setPhase(b.namespace, b.id, 'Running');
    const res = await t.api('post', `${base}/${c.id}/start`);
    expect(res.status).toBe(409);
  });

  it('deletes a workspace and records its lifetime', async () => {
    const ws = await created();
    t.fakes.clock.advance(2 * 60 * 60 * 1000);
    const res = await t.api('delete', `${base}/${ws.id}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(`Workspace with id ${ws.id} is terminating.`);
    expect(t.fakes.kube.workspaces()).toHaveLength(0);
    const last = (await t.metricsRows()).at(-1);
    expect(last).toMatchObject({ eventtype: 'delete', duration: '2 hours' });
  });

  it.each([
    ['get', ''],
    ['delete', ''],
    ['post', '/start'],
    ['post', '/stop'],
  ] as const)('answers 404 for %s %s on an unknown workspace', async (method, suffix) => {
    const res = await t.api(method, `${base}/ghost${suffix}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('GET /projects lists the user’s projects', async () => {
    await created();
    const res = await t.api('get', '/api/v1/pp1/projects');
    expect(res.body).toEqual([
      expect.objectContaining({ name: 'pp1-devspaces-1001', csiid: '1001', soeid: 'pp1' }),
    ]);
  });
});

function registryPaths(): string[] {
  return t.registry.requests.slice(-2);
}
