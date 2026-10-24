import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startIntegration, type Integration } from '../helpers/integration.js';
import { SAMPLE_PAT } from '../helpers/sample-devfile.js';

let t: Integration;
beforeAll(async () => {
  t = await startIntegration();
});
afterAll(() => t.close());
beforeEach(async () => {
  t.fakes.kube.namespaces.clear();
  t.fakes.kube.objects.clear();
  t.fakes.notifier.created.length = 0;
  t.fakes.notifier.existing.length = 0;
  t.fakes.notifier.deleted.length = 0;
  await t.sql('DELETE FROM metrics."devspaces-metrics"');
  t.fakes.kube.seedNamespace('pp1-devspaces-1001', 'pp1', '1001');
});

describe('personal access tokens', () => {
  const url = (name = 'work') => `/api/v1/pp1/pats/${name}`;

  it('runs the full create → list → view → update → delete lifecycle', async () => {
    const created = await t.api('post', url()).send({ csiid: '1001', token: SAMPLE_PAT });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'work', namespace: 'pp1-devspaces-1001' });

    expect((await t.api('get', '/api/v1/pp1/pats')).body).toEqual([
      expect.objectContaining({ name: 'work' }),
    ]);

    const view = await t.api('get', `${url()}?csiid=1001`);
    expect(view.status).toBe(200);
    expect(view.body.token).toBe(`gh…${SAMPLE_PAT.slice(-3)}`);
    expect(JSON.stringify(view.body)).not.toContain(SAMPLE_PAT);

    const next = `ghp_${'Q'.repeat(36)}`;
    expect((await t.api('put', url()).send({ csiid: '1001', token: next })).status).toBe(200);

    expect((await t.api('delete', `${url()}?csiid=1001`)).body.message).toBe("PAT 'work' deleted.");
    expect((await t.api('delete', `${url()}?csiid=1001`)).body.message).toMatch(/not found/);
  });

  it('records PAT events without the token', async () => {
    await t.api('post', url()).send({ csiid: '1001', token: SAMPLE_PAT });
    await t.api('put', url()).send({ csiid: '1001', token: SAMPLE_PAT });
    await t.api('delete', `${url()}?csiid=1001`);
    const rows = await t.metricsRows();
    expect(rows.map((r) => `${r.eventtype}:${r.resourcetype}`)).toEqual([
      'create:pat',
      'update:pat',
      'delete:pat',
    ]);
    expect(JSON.stringify(rows)).not.toContain(SAMPLE_PAT);
  });

  it('409 on duplicate, 404 on unknown, 400 on bad token or csiid', async () => {
    await t.api('post', url()).send({ csiid: '1001', token: SAMPLE_PAT });
    expect((await t.api('post', url()).send({ csiid: '1001', token: SAMPLE_PAT })).status).toBe(409);
    expect((await t.api('get', `${url('ghost')}?csiid=1001`)).status).toBe(404);
    expect((await t.api('put', url('ghost')).send({ csiid: '1001', token: SAMPLE_PAT })).status).toBe(404);
    const bad = await t.api('post', url('other')).send({ csiid: '1001', token: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_PAT');
    expect((await t.api('get', `${url()}`)).status).toBe(400);
    expect((await t.api('post', url('Bad_Name!')).send({ csiid: '1001', token: SAMPLE_PAT })).status).toBe(
      400,
    );
  });

  it('404s for a project that does not exist (and does not create it)', async () => {
    const res = await t.api('post', url()).send({ csiid: '9999', token: SAMPLE_PAT });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
    expect(t.fakes.kube.namespaces.has('pp1-devspaces-9999')).toBe(false);
  });
});

describe('git config', () => {
  const url = '/api/v1/pp1/gitconfig';
  const content = '[user]\n  name = Pat\n';

  it('supports put → get → delete', async () => {
    expect((await t.api('get', `${url}?csiid=1001`)).status).toBe(404);
    const put = await t.api('put', url).send({ csiid: '1001', content });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      name: 'workspace-userdata-gitconfig-configmap',
      namespace: 'pp1-devspaces-1001',
      content,
    });
    expect((await t.api('get', `${url}?csiid=1001`)).body.content).toBe(content);
    expect((await t.api('delete', `${url}?csiid=1001`)).body.message).toBe('Git config deleted.');
    expect((await t.api('delete', `${url}?csiid=1001`)).body.message).toMatch(/nothing to delete/);
  });

  it('records create then update', async () => {
    await t.api('put', url).send({ csiid: '1001', content });
    await t.api('put', url).send({ csiid: '1001', content: `${content}\n` });
    expect((await t.metricsRows()).map((r) => r.eventtype)).toEqual(['create', 'update']);
  });

  it('validates input', async () => {
    expect((await t.api('put', url).send({ csiid: '1001', content: '' })).status).toBe(400);
    expect((await t.api('get', url)).status).toBe(400);
  });
});

describe('deployment projects', () => {
  const url = '/api/v1/pp1/deployment-projects';
  const name = 'pp1-devspaces-deploy-1001';

  it('creates once (201), then reports the existing one (200)', async () => {
    const first = await t.api('post', url).send({ csiid: '1001' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ exists: false, name });
    expect(t.fakes.notifier.created).toEqual([{ soeid: 'pp1', namespace: name }]);

    const second = await t.api('post', url).send({ csiid: '1001' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ exists: true, name });
    expect(t.fakes.notifier.existing).toHaveLength(1);

    const rows = await t.metricsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventtype: 'create',
      resourcetype: 'deployment_namespace',
      csiid: '1001',
    });
  });

  it('lists and deletes the user’s deployment projects', async () => {
    await t.api('post', url).send({ csiid: '1001' });
    await t.api('post', url).send({ csiid: '1002' });
    expect((await t.api('get', url)).body.sort()).toEqual([name, 'pp1-devspaces-deploy-1002']);

    const res = await t.api('delete', url);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toHaveLength(2);
    expect(res.body.failed).toEqual([]);
    expect((await t.api('get', url)).body).toEqual([]);
    expect(t.fakes.notifier.deleted).toHaveLength(1);
    expect((await t.metricsRows()).filter((r) => r.eventtype === 'delete')).toHaveLength(2);
  });

  it('deleting when there are none is a harmless 200', async () => {
    const res = await t.api('delete', url);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exists: false, deleted: [] });
  });

  it('validates csiid', async () => {
    expect((await t.api('post', url).send({})).status).toBe(400);
    expect((await t.api('post', url).send({ csiid: 'x' })).status).toBe(400);
  });

  it('never touches another user’s deployment projects', async () => {
    t.fakes.kube.seedNamespace('pp2-devspaces-deploy-1', 'pp2');
    await t.api('delete', url);
    expect(t.fakes.kube.namespaces.has('pp2-devspaces-deploy-1')).toBe(true);
  });
});
