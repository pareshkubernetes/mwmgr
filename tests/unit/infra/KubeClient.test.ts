import { CoreV1Api, KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KubeClient, createKubeConfig, loadKubeConfig } from '../../../src/infra/kube/KubeClient.js';
import { ConflictError, ForbiddenError, NotFoundError, UpstreamError } from '../../../src/utils/errors.js';

const apiError = (code: number) =>
  Object.assign(new Error(`HTTP ${code}`), { code, body: { code, message: 'k8s says no' } });

function client(): KubeClient {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'c', server: 'https://localhost:6443', skipTLSVerify: true }],
    users: [{ name: 'u', token: 'test-token' }],
    contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
    currentContext: 'x',
  });
  return new KubeClient(kc);
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('namespaces', () => {
  it('lists with a label selector', async () => {
    const spy = vi
      .spyOn(CoreV1Api.prototype, 'listNamespace')
      .mockResolvedValue({ items: [{ metadata: { name: 'a' } }] } as never);
    expect(await client().listNamespaces('k=v')).toEqual([{ metadata: { name: 'a' } }]);
    expect(spy).toHaveBeenCalledWith({ labelSelector: 'k=v' });
  });

  it('getNamespace returns null on 404 and translates other errors', async () => {
    const spy = vi.spyOn(CoreV1Api.prototype, 'readNamespace');
    spy.mockRejectedValueOnce(apiError(404));
    expect(await client().getNamespace('x')).toBeNull();
    spy.mockRejectedValueOnce(apiError(403));
    await expect(client().getNamespace('x')).rejects.toBeInstanceOf(ForbiddenError);
    spy.mockResolvedValueOnce({ metadata: { name: 'x' } } as never);
    expect(await client().getNamespace('x')).toEqual({ metadata: { name: 'x' } });
  });

  it('createNamespace passes the body and maps conflicts', async () => {
    const spy = vi.spyOn(CoreV1Api.prototype, 'createNamespace');
    spy.mockResolvedValueOnce({ metadata: { name: 'n' } } as never);
    await client().createNamespace({ metadata: { name: 'n' } });
    expect(spy).toHaveBeenCalledWith({ body: { metadata: { name: 'n' } } });
    spy.mockRejectedValueOnce(apiError(409));
    await expect(client().createNamespace({ metadata: { name: 'n' } })).rejects.toBeInstanceOf(ConflictError);
  });

  it('deleteNamespace is false when already gone', async () => {
    const spy = vi.spyOn(CoreV1Api.prototype, 'deleteNamespace');
    spy.mockResolvedValueOnce({} as never);
    expect(await client().deleteNamespace('n')).toBe(true);
    spy.mockRejectedValueOnce(apiError(404));
    expect(await client().deleteNamespace('n')).toBe(false);
  });

  it('ping calls the API discovery endpoint and maps failures', async () => {
    const spy = vi.spyOn(CoreV1Api.prototype, 'getAPIResources');
    spy.mockResolvedValueOnce({} as never);
    await expect(client().ping()).resolves.toBeUndefined();
    spy.mockRejectedValueOnce(apiError(500));
    await expect(client().ping()).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('createProject', () => {
  it('sends a ProjectRequest and falls back to the requested name', async () => {
    const spy = vi
      .spyOn(KubernetesObjectApi.prototype, 'create')
      .mockResolvedValue({ kind: 'Project' } as never);
    const result = await client().createProject({ metadata: { name: 'proj' } });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      apiVersion: 'project.openshift.io/v1',
      kind: 'ProjectRequest',
    });
    expect(result.metadata?.name).toBe('proj');
  });
  it('keeps the name the platform returned', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'create').mockResolvedValue({
      metadata: { name: 'actual' },
    } as never);
    expect((await client().createProject({ metadata: { name: 'proj' } })).metadata?.name).toBe('actual');
  });
});

describe('namespaced objects', () => {
  it('get reads by apiVersion/kind and returns null on 404', async () => {
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read');
    read.mockResolvedValueOnce({ metadata: { name: 's' } } as never);
    expect(await client().get('Secret', 'ns', 's')).toEqual({ metadata: { name: 's' } });
    expect(read.mock.calls[0]?.[0]).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 's', namespace: 'ns' },
    });
    read.mockRejectedValueOnce(apiError(404));
    expect(await client().get('DevWorkspace', 'ns', 's')).toBeNull();
    expect(read.mock.calls[1]?.[0]).toMatchObject({ apiVersion: 'workspace.devfile.io/v1alpha2' });
  });

  it('list passes namespace and selector', async () => {
    const spy = vi
      .spyOn(KubernetesObjectApi.prototype, 'list')
      .mockResolvedValue({ items: [{ metadata: { name: 'a' } }] } as never);
    expect(await client().list('ConfigMap', 'ns', 'a=b')).toHaveLength(1);
    expect(spy.mock.calls[0]?.slice(0, 3)).toEqual(['v1', 'ConfigMap', 'ns']);
    expect(spy.mock.calls[0]?.[7]).toBe('a=b');
  });

  it('create stamps apiVersion, kind and namespace onto the body', async () => {
    const spy = vi
      .spyOn(KubernetesObjectApi.prototype, 'create')
      .mockResolvedValue({ metadata: { name: 'r' } } as never);
    await client().create('Role', 'ns', { metadata: { name: 'r' } });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'r', namespace: 'ns' },
    });
  });

  it('delete is false on 404', async () => {
    const spy = vi.spyOn(KubernetesObjectApi.prototype, 'delete');
    spy.mockResolvedValueOnce({} as never);
    expect(await client().delete('Secret', 'ns', 's')).toBe(true);
    spy.mockRejectedValueOnce(apiError(404));
    expect(await client().delete('Secret', 'ns', 's')).toBe(false);
  });

  it('setWorkspaceStarted sends a merge patch for spec.started', async () => {
    const spy = vi
      .spyOn(KubernetesObjectApi.prototype, 'patch')
      .mockResolvedValue({ spec: { started: false } } as never);
    await client().setWorkspaceStarted('ns', 'ws', false);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      kind: 'DevWorkspace',
      metadata: { name: 'ws', namespace: 'ns' },
      spec: { started: false },
    });
    expect(spy.mock.calls[0]?.[5]).toBe('application/merge-patch+json');
  });

  it('wraps unexpected failures as UpstreamError', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'create').mockRejectedValue(apiError(500));
    await expect(client().create('Secret', 'ns', { metadata: { name: 's' } })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe('apply', () => {
  it('creates when nothing exists', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'read').mockRejectedValue(apiError(404));
    const create = vi
      .spyOn(KubernetesObjectApi.prototype, 'create')
      .mockResolvedValue({ metadata: { name: 'q' } } as never);
    await client().apply('ResourceQuota', 'ns', { metadata: { name: 'q' } });
    expect(create).toHaveBeenCalledOnce();
  });

  it('replaces with the existing resourceVersion when the object exists', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'read').mockResolvedValue({
      metadata: { name: 'q', resourceVersion: '77' },
    } as never);
    const replace = vi
      .spyOn(KubernetesObjectApi.prototype, 'replace')
      .mockResolvedValue({ metadata: { name: 'q' } } as never);
    const create = vi.spyOn(KubernetesObjectApi.prototype, 'create');
    await client().apply('ResourceQuota', 'ns', { metadata: { name: 'q' } });
    expect(create).not.toHaveBeenCalled();
    expect(replace.mock.calls[0]?.[0]).toMatchObject({
      metadata: { name: 'q', namespace: 'ns', resourceVersion: '77' },
    });
  });

  it('recovers from losing a creation race by replacing the winner’s object', async () => {
    const read = vi.spyOn(KubernetesObjectApi.prototype, 'read');
    read.mockRejectedValueOnce(apiError(404));
    read.mockResolvedValueOnce({ metadata: { name: 'q', resourceVersion: '5' } } as never);
    vi.spyOn(KubernetesObjectApi.prototype, 'create').mockRejectedValue(apiError(409));
    const replace = vi
      .spyOn(KubernetesObjectApi.prototype, 'replace')
      .mockResolvedValue({ metadata: { name: 'q' } } as never);
    await client().apply('ResourceQuota', 'ns', { metadata: { name: 'q' } });
    expect(replace).toHaveBeenCalledOnce();
  });

  it('gives up with a Conflict when the race cannot be resolved', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'read').mockRejectedValue(apiError(404));
    vi.spyOn(KubernetesObjectApi.prototype, 'create').mockRejectedValue(apiError(409));
    await expect(client().apply('ResourceQuota', 'ns', { metadata: { name: 'q' } })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('surfaces other creation errors', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'read').mockRejectedValue(apiError(404));
    vi.spyOn(KubernetesObjectApi.prototype, 'create').mockRejectedValue(apiError(403));
    await expect(client().apply('Secret', 'ns', { metadata: { name: 's' } })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('loadKubeConfig', () => {
  it('fails clearly for a missing kubeconfig file', () => {
    expect(() => loadKubeConfig('/no/such/kubeconfig')).toThrow();
  });
  it('loads default config otherwise without throwing', () => {
    expect(() => loadKubeConfig()).not.toThrow();
  });
  it('NotFoundError is what a translated 404 looks like', async () => {
    vi.spyOn(KubernetesObjectApi.prototype, 'patch').mockRejectedValue(apiError(404));
    await expect(client().setWorkspaceStarted('ns', 'ws', true)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('createKubeConfig (cluster URL + bearer token, as the team exports them)', () => {
  const API = 'https://api.namctigtd001d.ecs.dyn.nsroot.net:6443';

  it('talks to the given cluster with the given token', () => {
    const kc = createKubeConfig({ apiUrl: API, token: 'fake-token' });
    expect(kc.getCurrentCluster()).toMatchObject({ server: API, skipTLSVerify: false });
    expect(kc.getCurrentUser()).toMatchObject({ token: 'fake-token' });
  });

  it('does not verify the cluster certificate only when asked to (NODE_TLS_REJECT_UNAUTHORIZED=0)', () => {
    expect(
      createKubeConfig({ apiUrl: API, token: 't', skipTlsVerify: true }).getCurrentCluster()?.skipTLSVerify,
    ).toBe(true);
    expect(
      createKubeConfig({ apiUrl: API, token: 't', skipTlsVerify: false }).getCurrentCluster()?.skipTLSVerify,
    ).toBe(false);
  });

  it('a token wins over a kubeconfig file', () => {
    const kc = createKubeConfig({ apiUrl: API, token: 'fake-token', kubeconfigPath: '/no/such/file' });
    expect(kc.getCurrentCluster()?.server).toBe(API);
  });

  it('without a token it falls back to the kubeconfig file, then to the default configuration', () => {
    expect(() => createKubeConfig({ apiUrl: API, kubeconfigPath: '/no/such/file' })).toThrow();
    expect(() => createKubeConfig({ apiUrl: API })).not.toThrow();
    expect(() => createKubeConfig({ apiUrl: '', token: 'ignored without a URL' })).not.toThrow();
  });

  it('the resulting config builds a working client', () => {
    expect(() => new KubeClient(createKubeConfig({ apiUrl: API, token: 'fake-token' }))).not.toThrow();
  });
});
