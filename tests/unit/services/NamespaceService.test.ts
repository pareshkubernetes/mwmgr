import { beforeEach, describe, expect, it } from 'vitest';
import { NamespaceService } from '../../../src/services/NamespaceService.js';
import { MetricsRecorder } from '../../../src/services/MetricsRecorder.js';
import { ConflictError, NotFoundError, UpstreamError } from '../../../src/utils/errors.js';
import { silentLogger } from '../../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore } from '../../helpers/fakes.js';
import { InMemoryKube } from '../../helpers/InMemoryKube.js';

let kube: InMemoryKube;
let metrics: FakeMetricsStore;

const make = (proxy?: string) =>
  new NamespaceService(
    kube,
    new MetricsRecorder(metrics, new FakeClock(), silentLogger),
    { workspaceProxyUrl: proxy, emailDomain: 'example.com' },
    silentLogger,
  );

beforeEach(() => {
  kube = new InMemoryKube();
  metrics = new FakeMetricsStore();
});

describe('ensure', () => {
  it('creates and provisions a namespace that does not exist', async () => {
    const result = await make().ensure('pp1', '1001');
    expect(result).toEqual({ name: 'pp1-devspaces-1001', created: true });

    const ns = kube.namespaces.get('pp1-devspaces-1001');
    expect(ns?.metadata?.labels).toMatchObject({ 'app.kubernetes.io/component': 'workspaces-namespace' });
    expect(ns?.metadata?.annotations).toEqual({ 'che.eclipse.org/username': 'pp1' });

    const kinds = [...kube.objects.keys()].map((k) => k.split('/')[0]);
    expect(kinds).toContain('Role');
    expect(kinds).toContain('RoleBinding');
    expect(kinds).toContain('ResourceQuota');
    expect(kinds).toContain('LimitRange');
    expect(kinds.filter((k) => k === 'NetworkPolicy')).toHaveLength(5);
  });

  it('binds the user to the user role', async () => {
    await make().ensure('pp1', '1001');
    const binding = kube.objects.get('RoleBinding/pp1-devspaces-1001/devspaces-project-access-pp1');
    expect(binding).toMatchObject({
      subjects: [{ kind: 'User', name: 'pp1' }],
      roleRef: { kind: 'Role', name: 'devspaces-user-role' },
    });
  });

  it('records a successful project create', async () => {
    await make().ensure('pp1', '1001');
    expect(metrics.records).toHaveLength(1);
    expect(metrics.records[0]).toMatchObject({
      eventtype: 'create',
      resourcetype: 'project',
      resourcename: 'pp1-devspaces-1001',
      csiid: '1001',
    });
  });

  it('returns an existing namespace without touching it', async () => {
    kube.seedNamespace('pp1-devspaces-1001', 'pp1', '1001');
    const result = await make().ensure('pp1', '1001');
    expect(result).toEqual({ name: 'pp1-devspaces-1001', created: false });
    expect(kube.calls).not.toContain('createNamespace');
    expect(metrics.records).toHaveLength(0);
  });

  it('refuses a namespace that belongs to someone else', async () => {
    kube.seedNamespace('pp1-devspaces-1001', 'intruder', '1001');
    await expect(make().ensure('pp1', '1001')).rejects.toBeInstanceOf(ConflictError);
  });

  it('adopts the namespace when it loses a creation race', async () => {
    const service = make();
    const create = kube.createNamespace.bind(kube);
    kube.createNamespace = async (body) => {
      kube.seedNamespace('pp1-devspaces-1001', 'pp1', '1001');
      return create(body);
    };
    expect(await service.ensure('pp1', '1001')).toEqual({ name: 'pp1-devspaces-1001', created: false });
    expect(kube.objects.size).toBe(0); // the winner provisions; we did not
  });

  it('rolls the namespace back and records the failure when provisioning fails', async () => {
    kube.failOnce('apply:ResourceQuota', new UpstreamError('quota api down'));
    await expect(make().ensure('pp1', '1001')).rejects.toBeInstanceOf(UpstreamError);
    expect(kube.namespaces.has('pp1-devspaces-1001')).toBe(false);
    expect(metrics.records[0]?.status).toMatchObject({ failed: true, error: 'quota api down' });
  });

  it('propagates a namespace creation failure that is not a race', async () => {
    kube.failOnce('createNamespace', new UpstreamError('api down'));
    await expect(make().ensure('pp1', '1001')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('adds proxy and git ConfigMaps when a proxy is configured', async () => {
    await make('http://proxy.example:8080').ensure('pp1', '1001');
    const env = kube.objects.get('ConfigMap/pp1-devspaces-1001/proxy-env-vars-ws-mgr');
    expect(env?.data).toMatchObject({
      HTTP_PROXY: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8080',
    });
    const git = kube.objects.get(
      'ConfigMap/pp1-devspaces-1001/workspace-userdata-gitconfig-configmap-ws-mgr',
    );
    expect(String((git?.data as Record<string, string>).gitconfig)).toContain('email = pp1@example.com');
  });

  it('adds no ConfigMaps without a proxy', async () => {
    await make().ensure('pp1', '1001');
    expect([...kube.objects.keys()].some((k) => k.startsWith('ConfigMap/'))).toBe(false);
  });
});

describe('require', () => {
  it('returns the name of an existing namespace', async () => {
    kube.seedNamespace('pp1-devspaces-1001', 'pp1');
    expect(await make().require('pp1', '1001')).toBe('pp1-devspaces-1001');
  });
  it('throws NotFound when missing and never creates', async () => {
    await expect(make().require('pp1', '1001')).rejects.toBeInstanceOf(NotFoundError);
    expect(kube.namespaces.size).toBe(0);
  });
  it('throws Conflict for another user’s namespace', async () => {
    kube.seedNamespace('pp1-devspaces-1001', 'other');
    await expect(make().require('pp1', '1001')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('listForUser / listProjects', () => {
  it('returns only the user’s workspace namespaces', async () => {
    kube.seedNamespace('pp1-devspaces-1', 'pp1', '1');
    kube.seedNamespace('pp1-devspaces-2', 'pp1', '2');
    kube.seedNamespace('pp2-devspaces-1', 'pp2', '1');
    kube.namespaces.set('pp1-unrelated', {
      metadata: { name: 'pp1-unrelated', annotations: { 'che.eclipse.org/username': 'pp1' } },
    });

    const list = await make().listForUser('pp1');
    expect(list.map((n) => n.metadata?.name).sort()).toEqual(['pp1-devspaces-1', 'pp1-devspaces-2']);
  });

  it('describes projects with csiid and creation time', async () => {
    kube.seedNamespace('pp1-devspaces-7', 'pp1', '7');
    const [project] = await make().listProjects('pp1');
    expect(project).toMatchObject({ name: 'pp1-devspaces-7', csiid: '7', soeid: 'pp1' });
    expect(project?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('derives the csiid from the name when the label is missing', async () => {
    kube.seedNamespace('pp1-devspaces-7', 'pp1', '7');
    const ns = kube.namespaces.get('pp1-devspaces-7');
    delete ns?.metadata?.labels?.['devspaces.citi.com/csiid'];
    expect((await make().listProjects('pp1'))[0]?.csiid).toBe('7');
  });
});
