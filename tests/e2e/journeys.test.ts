import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  caller,
  startControllerSimulation,
  startE2E,
  waitFor,
  type Caller,
  type E2E,
} from '../helpers/e2e.js';
import { SAMPLE_PAT } from '../helpers/sample-devfile.js';
import { TEST_SECRET } from '../helpers/testkit.js';

let e2e: E2E;
let call: Caller;
let stopController: () => void;

beforeAll(async () => {
  e2e = await startE2E();
  ({ call } = await e2e.login());
});
afterAll(() => e2e.stop());
beforeEach(async () => {
  e2e.fakes.kube.namespaces.clear();
  e2e.fakes.kube.objects.clear();
  e2e.fakes.metrics.records.length = 0;
  e2e.fakes.notifier.created.length = 0;
  e2e.fakes.notifier.existing.length = 0;
  e2e.fakes.notifier.deleted.length = 0;
  e2e.registry.failing = false;
  await e2e.sql('DELETE FROM metrics."devspaces-metrics"');
  stopController = startControllerSimulation(e2e.fakes.kube);
});
afterEach(() => stopController());

const events = async () =>
  (await e2e.sql('SELECT eventtype, resourcetype FROM metrics."devspaces-metrics" ORDER BY id')).map(
    (r) => `${r.eventtype}:${r.resourcetype}`,
  );

describe('journey: a developer’s day', () => {
  it('logs in, picks a stack, works, stops, resumes and cleans up', async () => {
    // Orion shows the stacks
    const catalog = await call('GET', '/api/v1/catalog');
    expect(catalog.status).toBe(200);
    const stack = catalog.body[0].name as string;
    expect(stack).toBe('java-maven');

    // Create (the project does not exist yet, so it is created too)
    const created = await call('POST', '/api/v1/pp58386/workspaces', {
      devworkspaceValue: stack,
      csiid: '177398',
    });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(created.body.namespace).toBe('pp58386-devspaces-177398');

    // The controller brings it up
    const running = await waitFor('workspace Running', async () => {
      const ws = await call('GET', `/api/v1/pp58386/workspaces/${id}`);
      return ws.body.phase === 'Running' ? ws.body : undefined;
    });
    expect(running.mainUrl).toBe(`https://${id}.apps.test/`);

    // It appears in the list and in the project list
    expect((await call('GET', '/api/v1/pp58386/workspaces')).body).toHaveLength(1);
    expect((await call('GET', '/api/v1/pp58386/projects')).body[0]).toMatchObject({ csiid: '177398' });

    // Stop after an hour of work
    e2e.fakes.clock.advance(60 * 60 * 1000);
    expect((await call('POST', `/api/v1/pp58386/workspaces/${id}/stop`)).status).toBe(200);
    await waitFor(
      'workspace Stopped',
      async () => (await call('GET', `/api/v1/pp58386/workspaces/${id}`)).body.phase === 'Stopped',
    );

    // Resume
    expect((await call('POST', `/api/v1/pp58386/workspaces/${id}/start`)).status).toBe(200);
    await waitFor(
      'workspace Running again',
      async () => (await call('GET', `/api/v1/pp58386/workspaces/${id}`)).body.phase === 'Running',
    );

    // Delete
    expect((await call('DELETE', `/api/v1/pp58386/workspaces/${id}`)).status).toBe(200);
    expect((await call('GET', '/api/v1/pp58386/workspaces')).body).toEqual([]);
    expect(e2e.fakes.kube.workspaces()).toHaveLength(0);

    // Everything was recorded for the dashboard, in order
    expect(await events()).toEqual([
      'create:project',
      'create:workspace',
      'stop:workspace',
      'start:workspace',
      'delete:workspace',
    ]);
    const stop = (
      await e2e.sql(`SELECT duration FROM metrics."devspaces-metrics" WHERE eventtype = 'stop'`)
    )[0];
    expect(stop?.duration).toBe('1 hour');
  });

  it('keeps a developer’s tooling in sync: git config, PAT, deployment project', async () => {
    await call('POST', '/api/v1/pp1/workspaces', { devworkspaceValue: 'python', csiid: '5' });

    expect(
      (await call('PUT', '/api/v1/pp1/gitconfig', { csiid: '5', content: '[user]\n  name = Pat\n' })).status,
    ).toBe(200);
    expect((await call('POST', '/api/v1/pp1/pats/main', { csiid: '5', token: SAMPLE_PAT })).status).toBe(201);
    const pats = await call('GET', '/api/v1/pp1/pats');
    expect(pats.body).toEqual([expect.objectContaining({ name: 'main', namespace: 'pp1-devspaces-5' })]);

    const deploy = await call('POST', '/api/v1/pp1/deployment-projects', { csiid: '5' });
    expect(deploy.status).toBe(201);
    expect(e2e.fakes.notifier.created).toHaveLength(1);
    expect((await call('GET', '/api/v1/pp1/deployment-projects')).body).toEqual(['pp1-devspaces-deploy-5']);

    expect((await call('DELETE', '/api/v1/pp1/deployment-projects')).body.deleted).toEqual([
      'pp1-devspaces-deploy-5',
    ]);
    expect(e2e.fakes.notifier.deleted).toHaveLength(1);

    expect(await events()).toEqual([
      'create:project',
      'create:workspace',
      'create:gitconfig',
      'create:pat',
      'create:deployment_namespace',
      'delete:deployment_namespace',
    ]);
    // and no secret ever reached the metrics table
    expect(JSON.stringify(await e2e.sql('SELECT * FROM metrics."devspaces-metrics"'))).not.toContain(
      SAMPLE_PAT,
    );
  });
});

describe('journey: several users share the platform', () => {
  it('isolates users from each other', async () => {
    const a = await call('POST', '/api/v1/alice1/workspaces', {
      devworkspaceValue: 'java-maven',
      csiid: '1',
    });
    const b = await call('POST', '/api/v1/bob22/workspaces', { devworkspaceValue: 'python', csiid: '2' });
    expect((await call('GET', '/api/v1/alice1/workspaces')).body.map((w: { id: string }) => w.id)).toEqual([
      a.body.id,
    ]);
    expect((await call('GET', '/api/v1/bob22/workspaces')).body.map((w: { id: string }) => w.id)).toEqual([
      b.body.id,
    ]);
    expect((await call('DELETE', `/api/v1/bob22/workspaces/${a.body.id}`)).status).toBe(404);
    expect(e2e.fakes.kube.workspaces()).toHaveLength(2);
  });

  it('a user token reaches only its own resources', async () => {
    const userToken = jwt.sign({ role: 'user' }, TEST_SECRET, { subject: 'alice1' });
    const asAlice = caller(e2e.baseUrl, userToken);
    expect((await asAlice('GET', '/api/v1/alice1/workspaces')).status).toBe(200);
    expect((await asAlice('GET', '/api/v1/bob22/workspaces')).status).toBe(403);
    expect(
      (await asAlice('POST', '/api/v1/bob22/workspaces', { devworkspaceValue: 'python', csiid: '2' })).status,
    ).toBe(403);
    expect(e2e.fakes.kube.namespaces.size).toBe(0);
  });

  it('enforces the per-user limits while other users are unaffected', async () => {
    const make = (user: string, csiid: string) =>
      call('POST', `/api/v1/${user}/workspaces`, { devworkspaceValue: 'python', csiid });
    stopController(); // keep workspaces "active" so the running limit bites
    expect((await make('alice1', '1')).status).toBe(200);
    expect((await make('alice1', '1')).status).toBe(200);
    const blocked = await make('alice1', '1');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('WORKSPACE_RUN_COUNT_EXCEEDED');
    expect((await make('bob22', '2')).status).toBe(200);
  });

  it('survives two simultaneous first requests for a brand-new project', async () => {
    stopController();
    const [x, y] = await Promise.all([
      call('POST', '/api/v1/carol3/workspaces', { devworkspaceValue: 'python', csiid: '3' }),
      call('POST', '/api/v1/carol3/workspaces', { devworkspaceValue: 'python', csiid: '3' }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(e2e.fakes.kube.workspaces('carol3-devspaces-3')).toHaveLength(2);
    expect([...e2e.fakes.kube.namespaces.keys()]).toEqual(['carol3-devspaces-3']);
  });
});

describe('journey: things go wrong', () => {
  it('unauthenticated callers get nothing', async () => {
    for (const path of [
      '/api/v1/catalog',
      '/api/v1/pp1/workspaces',
      '/api/v1/pp1/pats',
      '/api/v1/pp1/deployment-projects',
    ]) {
      expect((await e2e.anonymous('GET', path)).status).toBe(401);
    }
    expect((await e2e.anonymous('POST', '/api/v1/login', { username: 'x', password: 'y' })).status).toBe(401);
  });

  it('a registry outage is a clean 502 that creates nothing and is recorded', async () => {
    e2e.registry.failing = true;
    const res = await call('POST', '/api/v1/pp1/workspaces', { devworkspaceValue: 'java-maven', csiid: '1' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(e2e.fakes.kube.workspaces()).toHaveLength(0);
    // recovery without restarting anything
    e2e.registry.failing = false;
    expect(
      (await call('POST', '/api/v1/pp1/workspaces', { devworkspaceValue: 'java-maven', csiid: '1' })).status,
    ).toBe(200);
  });

  it('a cluster failure while creating a workspace is recorded as a failed event', async () => {
    e2e.fakes.kube.failOnce(
      'create:DevWorkspace',
      Object.assign(new Error('admission webhook denied the request'), { code: 500 }),
    );
    const res = await call('POST', '/api/v1/pp1/workspaces', { devworkspaceValue: 'java-maven', csiid: '1' });
    expect(res.status).toBe(500);
    const [row] = await e2e.sql(
      `SELECT status FROM metrics."devspaces-metrics" WHERE resourcetype = 'workspace'`,
    );
    expect(row?.status).toMatchObject({ failed: true });
    expect(JSON.stringify(row?.status)).toContain('admission webhook denied');
  });

  it('a metrics database outage never blocks the user', async () => {
    // The harness uses pg-mem, so simulate the outage by breaking the recorder's store.
    const original = e2e.container.metrics.insert.bind(e2e.container.metrics);
    e2e.container.metrics.insert = async () => {
      throw new Error('connection to metrics database lost');
    };
    try {
      const res = await call('POST', '/api/v1/pp1/workspaces', { devworkspaceValue: 'python', csiid: '1' });
      expect(res.status).toBe(200);
      expect((await call('GET', '/api/v1/pp1/workspaces')).body).toHaveLength(1);
      expect((await e2e.anonymous('GET', '/healthz')).status).toBe(200);
    } finally {
      e2e.container.metrics.insert = original;
    }
  });

  it('readiness reflects the cluster, liveness does not', async () => {
    expect((await e2e.anonymous('GET', '/readyz')).status).toBe(200);
    e2e.fakes.kube.failOnce('ping', new Error('api server down'));
    const down = await e2e.anonymous('GET', '/readyz');
    expect(down.status).toBe(503);
    expect(down.body.checks.kubernetes).toBe('unavailable');
    expect((await e2e.anonymous('GET', '/healthz')).status).toBe(200);
  });

  it('answers malformed requests with 400s, not crashes', async () => {
    const bad = await fetch(`${e2e.baseUrl}/api/v1/pp1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${(await e2e.login()).token}` },
      body: '{"devworkspaceValue":',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_JSON');
    expect(
      (await call('POST', '/api/v1/pp1/workspaces', { devworkspaceValue: '../../etc/passwd', csiid: '1' }))
        .status,
    ).toBe(400);
    expect((await call('GET', '/api/v1/..%2F..%2Fetc/workspaces')).status).toBe(400);
  });
});

describe('journey: a client that has not migrated to /api/v1 yet', () => {
  it('keeps working on the old paths, flagged as deprecated', async () => {
    const login = await e2e.anonymous('POST', '/login', {
      username: 'orion-admin',
      password: 'correct horse battery staple',
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('deprecation')).toBe('true');
    const old = caller(e2e.baseUrl, login.body.token);

    const created = await old('POST', '/pp1/workspaces', { devworkspaceValue: 'python', csiid: '7' });
    expect(created.status).toBe(200);
    expect(created.headers.get('link')).toContain('/api/v1/pp1/workspaces');

    // and the same data is visible through v1
    const viaV1 = await call('GET', '/api/v1/pp1/workspaces');
    expect(viaV1.body.map((w: { id: string }) => w.id)).toEqual([created.body.id]);
    expect(viaV1.headers.get('deprecation')).toBeNull();
  });
});
