import { beforeEach, describe, expect, it } from 'vitest';
import { DeploymentNamespaceService } from '../../../src/services/DeploymentNamespaceService.js';
import { MetricsRecorder } from '../../../src/services/MetricsRecorder.js';
import { UpstreamError } from '../../../src/utils/errors.js';
import { silentLogger } from '../../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore, FakeNotifier } from '../../helpers/fakes.js';
import { InMemoryKube } from '../../helpers/InMemoryKube.js';

let kube: InMemoryKube;
let metrics: FakeMetricsStore;
let notifier: FakeNotifier;
let service: DeploymentNamespaceService;
const name = 'pp1-devspaces-deploy-1001';

beforeEach(() => {
  kube = new InMemoryKube();
  metrics = new FakeMetricsStore();
  notifier = new FakeNotifier();
  service = new DeploymentNamespaceService(
    kube,
    new MetricsRecorder(metrics, new FakeClock(), silentLogger),
    notifier,
    'devspaces-support-team',
    silentLogger,
  );
});

describe('ensure', () => {
  it('creates the project, quotas, limit range and RBAC, then emails the user', async () => {
    expect(await service.ensure('pp1', '1001')).toEqual({ exists: false, name });

    expect(kube.namespaces.get(name)?.metadata?.annotations).toMatchObject({
      'che.eclipse.org/username': 'pp1',
      'openshift.io/requester': 'devspaces-support-team',
    });
    const keys = [...kube.objects.keys()];
    expect(keys).toEqual(
      expect.arrayContaining([
        `ResourceQuota/${name}/compute-resources`,
        `ResourceQuota/${name}/storage-quota`,
        `LimitRange/${name}/default-limits`,
        `Role/${name}/devspaces-builder-role`,
        `Role/${name}/devspaces-deployer-role`,
        `RoleBinding/${name}/devspaces-builder-role-pp1-binding`,
        `RoleBinding/${name}/devspaces-deployer-role-pp1-binding`,
      ]),
    );
    expect(kube.objects.get(`RoleBinding/${name}/devspaces-builder-role-pp1-binding`)?.subjects).toEqual([
      { kind: 'User', name: 'pp1', apiGroup: 'rbac.authorization.k8s.io' },
      { kind: 'ServiceAccount', name: 'default', namespace: name },
    ]);
    expect(notifier.created).toEqual([{ soeid: 'pp1', namespace: name }]);
    expect(metrics.records[0]).toMatchObject({
      eventtype: 'create',
      resourcetype: 'deployment_namespace',
      resourcename: name,
      csiid: '1001',
    });
  });

  it('uses the name the platform actually gave the project', async () => {
    const original = kube.createProject.bind(kube);
    kube.createProject = async (body) => {
      const created = await original(body);
      return { ...created, metadata: { ...created.metadata, name: created.metadata?.name } };
    };
    expect((await service.ensure('pp1', '1001')).name).toBe(name);
  });

  it('returns the existing project and emails an “already exists” notice', async () => {
    kube.seedNamespace(name, 'pp1');
    expect(await service.ensure('pp1', '1001')).toEqual({ exists: true, name });
    expect(notifier.existing).toEqual([{ soeid: 'pp1', newNamespace: name, existingNamespace: name }]);
    expect(notifier.created).toHaveLength(0);
    expect(kube.calls).not.toContain('createProject');
  });

  it('records the failure, sends no email, and rethrows when provisioning fails', async () => {
    kube.failOnce('apply:ResourceQuota', new UpstreamError('quota denied'));
    await expect(service.ensure('pp1', '1001')).rejects.toBeInstanceOf(UpstreamError);
    expect(notifier.created).toHaveLength(0);
    expect(metrics.records[0]?.status).toMatchObject({ failed: true, error: 'quota denied' });
  });
});

describe('list', () => {
  it('matches only the user’s deployment namespaces', async () => {
    for (const n of [
      'pp1-devspaces-deploy-1',
      'pp1-devspaces-deploy-22',
      'pp12-devspaces-deploy-1',
      'pp1-devspaces-1',
      'pp1-devspaces-deploy-x',
    ]) {
      kube.seedNamespace(n, 'pp1');
    }
    expect((await service.list('pp1')).sort()).toEqual(['pp1-devspaces-deploy-1', 'pp1-devspaces-deploy-22']);
  });
});

describe('delete', () => {
  it('reports nothing to do when the user has no deployment namespaces', async () => {
    expect(await service.delete('pp1')).toEqual({
      exists: false,
      deleted: [],
      failed: [],
      message: 'No deployment namespaces found for user.',
    });
    expect(notifier.deleted).toHaveLength(0);
  });

  it('deletes them all, records each, and emails one confirmation', async () => {
    kube.seedNamespace('pp1-devspaces-deploy-1', 'pp1');
    kube.seedNamespace('pp1-devspaces-deploy-2', 'pp1');
    const result = await service.delete('pp1');
    expect(result.deleted.sort()).toEqual(['pp1-devspaces-deploy-1', 'pp1-devspaces-deploy-2']);
    expect(result.exists).toBe(true);
    expect(kube.namespaces.size).toBe(0);
    expect(metrics.records.map((r) => r.csiid).sort()).toEqual(['1', '2']);
    expect(notifier.deleted).toHaveLength(1);
    expect(notifier.deleted[0]?.namespaces).toHaveLength(2);
  });

  it('keeps going after a failure and reports both outcomes', async () => {
    kube.seedNamespace('pp1-devspaces-deploy-1', 'pp1');
    kube.seedNamespace('pp1-devspaces-deploy-2', 'pp1');
    kube.failOnce('deleteNamespace', new UpstreamError('finalizer stuck'));
    const result = await service.delete('pp1');
    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.message).toMatch(/Deleted 1.*Failed to delete 1/);
    expect(metrics.records.filter((r) => r.status.failed)).toHaveLength(1);
  });

  it('sends no email when nothing was deleted', async () => {
    kube.seedNamespace('pp1-devspaces-deploy-1', 'pp1');
    kube.failOnce('deleteNamespace', new UpstreamError('nope'));
    const result = await service.delete('pp1');
    expect(result.exists).toBe(false);
    expect(notifier.deleted).toHaveLength(0);
  });
});
