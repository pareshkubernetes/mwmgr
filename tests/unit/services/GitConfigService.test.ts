import { beforeEach, describe, expect, it } from 'vitest';
import { GitConfigService, GITCONFIG_CONFIGMAP } from '../../../src/services/GitConfigService.js';
import { MetricsRecorder } from '../../../src/services/MetricsRecorder.js';
import { NamespaceService } from '../../../src/services/NamespaceService.js';
import { BadRequestError, NotFoundError } from '../../../src/utils/errors.js';
import { silentLogger } from '../../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore } from '../../helpers/fakes.js';
import { InMemoryKube } from '../../helpers/InMemoryKube.js';

let kube: InMemoryKube;
let metrics: FakeMetricsStore;
let service: GitConfigService;
const ns = 'pp1-devspaces-1001';
const content = '[user]\n  name = Pat\n  email = pat@example.com\n';

beforeEach(() => {
  kube = new InMemoryKube();
  metrics = new FakeMetricsStore();
  const recorder = new MetricsRecorder(metrics, new FakeClock(), silentLogger);
  service = new GitConfigService(kube, new NamespaceService(kube, recorder, { emailDomain: 'x' }), recorder);
  kube.seedNamespace(ns, 'pp1', '1001');
});

describe('GitConfigService', () => {
  it('creates a ConfigMap mounted at /home/user/.gitconfig', async () => {
    const file = await service.upsert('pp1', '1001', content);
    expect(file).toEqual({ name: GITCONFIG_CONFIGMAP, namespace: ns, content });
    const cm = kube.objects.get(`ConfigMap/${ns}/${GITCONFIG_CONFIGMAP}`);
    expect(cm?.data).toEqual({ '.gitconfig': content });
    expect(cm?.metadata?.annotations).toMatchObject({
      'controller.devfile.io/mount-as': 'subpath',
      'controller.devfile.io/mount-path': '/home/user',
    });
    expect(cm?.metadata?.labels).toMatchObject({ 'controller.devfile.io/mount-to-devworkspace': 'true' });
  });

  it('records create the first time and update afterwards', async () => {
    await service.upsert('pp1', '1001', content);
    await service.upsert('pp1', '1001', `${content}[core]\n  autocrlf = false\n`);
    expect(metrics.records.map((r) => r.eventtype)).toEqual(['create', 'update']);
    expect(metrics.records.every((r) => r.resourcetype === 'gitconfig')).toBe(true);
  });

  it('views the stored content', async () => {
    await service.upsert('pp1', '1001', content);
    expect((await service.view('pp1', '1001')).content).toBe(content);
  });

  it('404s when there is no git config', async () => {
    await expect(service.view('pp1', '1001')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects empty or oversized content without touching the cluster', async () => {
    await expect(service.upsert('pp1', '1001', '   \n')).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.upsert('pp1', '1001', 'x'.repeat(65 * 1024))).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(kube.calls).toHaveLength(0);
  });

  it('needs an existing project', async () => {
    await expect(service.upsert('pp1', '9999', content)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes, reporting whether anything was there', async () => {
    await service.upsert('pp1', '1001', content);
    expect(await service.delete('pp1', '1001')).toBe(true);
    expect(await service.delete('pp1', '1001')).toBe(false);
  });
});
