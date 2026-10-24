import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeObject } from '../../../src/domain/types.js';
import { MetricsRecorder } from '../../../src/services/MetricsRecorder.js';
import { NamespaceService } from '../../../src/services/NamespaceService.js';
import { PatService, assertValidGithubToken, maskToken } from '../../../src/services/PatService.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../src/utils/errors.js';
import { silentLogger } from '../../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore } from '../../helpers/fakes.js';
import { InMemoryKube } from '../../helpers/InMemoryKube.js';
import { SAMPLE_PAT } from '../../helpers/sample-devfile.js';

let kube: InMemoryKube;
let metrics: FakeMetricsStore;
let service: PatService;
const ns = 'pp1-devspaces-1001';

beforeEach(() => {
  kube = new InMemoryKube();
  metrics = new FakeMetricsStore();
  const recorder = new MetricsRecorder(metrics, new FakeClock(), silentLogger);
  const namespaces = new NamespaceService(kube, recorder, { emailDomain: 'example.com' }, silentLogger);
  service = new PatService(kube, namespaces, recorder, { url: 'https://github.com', userSuffix: '_citi' });
  kube.seedNamespace(ns, 'pp1', '1001');
});

const secret = (name: string) =>
  kube.objects.get(`Secret/${ns}/git-credentials-secret-${name}`) as KubeObject;
const decoded = (name: string) =>
  Buffer.from((secret(name).data as Record<string, string>).credentials ?? '', 'base64').toString();

describe('token validation', () => {
  it('accepts a classic PAT', () => expect(() => assertValidGithubToken(SAMPLE_PAT)).not.toThrow());
  it.each(['', 'ghp_short', `gho_${'a'.repeat(36)}`, `ghp_${'a'.repeat(37)}`, `ghp_${'!'.repeat(36)}`])(
    'rejects %j',
    (token) => expect(() => assertValidGithubToken(token)).toThrow(BadRequestError),
  );
  it('masks tokens', () => {
    expect(maskToken(SAMPLE_PAT)).toBe(`gh…${SAMPLE_PAT.slice(-3)}`);
    expect(maskToken('abc')).toBe('***');
  });
});

describe('create', () => {
  it('stores credentials the way Dev Spaces mounts them', async () => {
    const summary = await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    expect(summary).toMatchObject({ namespace: ns, name: 'work' });
    expect(decoded('work')).toBe(`https://pp1_citi:${SAMPLE_PAT}@github.com`);
    expect(secret('work').metadata?.labels).toMatchObject({ 'controller.devfile.io/git-credential': 'true' });
    expect(secret('work').metadata?.annotations).toMatchObject({
      'che.eclipse.org/mount-path': '/.git-credentials',
    });
  });

  it('uses the plain soeid when no suffix is configured', async () => {
    const recorder = new MetricsRecorder(metrics, new FakeClock(), silentLogger);
    const plain = new PatService(kube, new NamespaceService(kube, recorder, { emailDomain: 'x' }), recorder, {
      url: 'https://ghe.example.com',
      userSuffix: '',
    });
    await plain.create('pp1', '1001', 'ghe', SAMPLE_PAT);
    expect(decoded('ghe')).toBe(`https://pp1:${SAMPLE_PAT}@ghe.example.com`);
  });

  it('records a create metric that never contains the token', async () => {
    await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    expect(metrics.records[0]).toMatchObject({
      eventtype: 'create',
      resourcetype: 'pat',
      resourcename: 'git-credentials-secret-work',
    });
    expect(JSON.stringify(metrics.records)).not.toContain(SAMPLE_PAT);
  });

  it('conflicts when the name is taken', async () => {
    await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    await expect(service.create('pp1', '1001', 'work', SAMPLE_PAT)).rejects.toBeInstanceOf(ConflictError);
  });

  it('validates before touching the cluster', async () => {
    await expect(service.create('pp1', '1001', 'work', 'bad')).rejects.toBeInstanceOf(BadRequestError);
    expect(kube.calls).toHaveLength(0);
  });

  it('needs an existing project', async () => {
    await expect(service.create('pp1', '9999', 'work', SAMPLE_PAT)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('view', () => {
  it('returns the token masked, never in full', async () => {
    await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    const view = await service.view('pp1', '1001', 'work');
    expect(view.token).toBe(maskToken(SAMPLE_PAT));
    expect(JSON.stringify(view)).not.toContain(SAMPLE_PAT);
    expect(view).toMatchObject({ name: 'work', namespace: ns, scmUrl: 'https://github.com' });
  });
  it('flags unrecognised secret contents', async () => {
    await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    (secret('work').data as Record<string, string>).credentials = Buffer.from('garbage').toString('base64');
    expect((await service.view('pp1', '1001', 'work')).token).toBe('[unrecognized format]');
  });
  it('404s for an unknown token', async () => {
    await expect(service.view('pp1', '1001', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('update', () => {
  it('replaces the token', async () => {
    await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    const next = `ghp_${'Z'.repeat(36)}`;
    await service.update('pp1', '1001', 'work', next);
    expect(decoded('work')).toContain(next);
    expect(metrics.records.at(-1)).toMatchObject({ eventtype: 'update', resourcetype: 'pat' });
  });
  it('404s for an unknown token and rejects bad tokens', async () => {
    await expect(service.update('pp1', '1001', 'nope', SAMPLE_PAT)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.update('pp1', '1001', 'nope', 'bad')).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('delete', () => {
  it('deletes and reports true', async () => {
    await service.create('pp1', '1001', 'work', SAMPLE_PAT);
    expect(await service.delete('pp1', '1001', 'work')).toBe(true);
    expect(kube.objects.size).toBe(0);
    expect(metrics.records.at(-1)).toMatchObject({ eventtype: 'delete', resourcetype: 'pat' });
  });
  it('is a success when already gone (false)', async () => {
    expect(await service.delete('pp1', '1001', 'ghost')).toBe(false);
  });
});

describe('list', () => {
  it('lists the user’s PAT secrets across namespaces, ignoring other secrets', async () => {
    kube.seedNamespace('pp1-devspaces-1002', 'pp1', '1002');
    await service.create('pp1', '1001', 'one', SAMPLE_PAT);
    await service.create('pp1', '1002', 'two', SAMPLE_PAT);
    await kube.create('Secret', ns, {
      metadata: { name: 'other-secret', labels: { 'controller.devfile.io/git-credential': 'true' } },
    });
    await kube.create('Secret', ns, { metadata: { name: 'git-credentials-secret-unlabelled' } });
    const list = await service.list('pp1');
    expect(list.map((p) => `${p.namespace}/${p.name}`).sort()).toEqual([
      'pp1-devspaces-1001/one',
      'pp1-devspaces-1002/two',
    ]);
  });
});
