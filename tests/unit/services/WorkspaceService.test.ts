import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateWorkspaceInput } from '../../../src/domain/types.js';
import { MetricsRecorder } from '../../../src/services/MetricsRecorder.js';
import { NamespaceService } from '../../../src/services/NamespaceService.js';
import { WorkspaceService, isActive, toWorkspace } from '../../../src/services/WorkspaceService.js';
import {
  NotFoundError,
  UpstreamError,
  WorkspaceConfigNotFoundError,
  WorkspaceCountExceededError,
  WorkspaceRunCountExceededError,
} from '../../../src/utils/errors.js';
import { silentLogger } from '../../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore, FakeRegistry } from '../../helpers/fakes.js';
import { InMemoryKube } from '../../helpers/InMemoryKube.js';

let kube: InMemoryKube;
let metrics: FakeMetricsStore;
let registry: FakeRegistry;
let clock: FakeClock;
let service: WorkspaceService;

const input = (over: Partial<CreateWorkspaceInput> = {}): CreateWorkspaceInput => ({
  soeid: 'pp1',
  csiid: '1001',
  devworkspaceValue: 'java-maven',
  editor: 'vscode',
  ...over,
});

beforeEach(() => {
  clock = new FakeClock();
  kube = new InMemoryKube(() => clock.now());
  metrics = new FakeMetricsStore();
  registry = new FakeRegistry();
  const recorder = new MetricsRecorder(metrics, clock, silentLogger);
  const namespaces = new NamespaceService(kube, recorder, { emailDomain: 'example.com' }, silentLogger);
  service = new WorkspaceService(
    kube,
    namespaces,
    registry,
    recorder,
    {
      limits: { maxRunning: 2, maxTotal: 3 },
      editors: {
        vscode: 'che-incubator/che-code/latest',
        intellij: 'che-incubator/che-idea/latest',
        goland: 'che-incubator/che-goland/latest',
      },
      devSpacesServiceFqdn: 'https://devspaces.test',
    },
    clock,
    silentLogger,
  );
});

const wsNamespace = 'pp1-devspaces-1001';
const onlyWorkspace = () => kube.workspaces()[0]!;

describe('create', () => {
  it('creates the namespace and a started DevWorkspace, and returns it', async () => {
    const ws = await service.create(input());
    expect(kube.namespaces.has(wsNamespace)).toBe(true);
    expect(kube.workspaces()).toHaveLength(1);
    expect(ws).toMatchObject({
      namespace: wsNamespace,
      csiid: '1001',
      stack: 'java-maven',
      version: '2.0.0',
      displayName: 'Java Maven',
      editor: 'Visual Studio Code',
      phase: 'Starting',
    });
    expect(ws.id).toMatch(/^java-maven-[0-9a-f]{4}$/);
    expect(onlyWorkspace().spec?.started).toBe(true);
  });

  it('uses a requested stack version', async () => {
    expect((await service.create(input({ stackVersion: '1.0.0' }))).version).toBe('1.0.0');
  });

  it('applies the JetBrains editor profile to the devfile', async () => {
    await service.create(input({ editor: 'intellij' }));
    const names = onlyWorkspace().spec?.template?.components?.map((c) => c.name);
    expect(names).toContain('che-idea-server');
    expect(names).not.toContain('venv');
    expect(onlyWorkspace().spec?.contributions?.[0]?.uri).toContain('che-incubator/che-idea/latest');
  });

  it('records a create metric with the stack’s resources, version and editor', async () => {
    await service.create(input());
    expect(metrics.records.filter((r) => r.resourcetype === 'workspace')).toEqual([
      expect.objectContaining({
        eventtype: 'create',
        soeid: 'pp1',
        csiid: '1001',
        workspaceversion: '2.0.0',
        editorname: 'vscode',
        limitcpu: 2,
        limitmemory: 4,
        storage: 3,
        status: { failed: false, error: '', message: '' },
      }),
    ]);
  });

  it('rejects an unknown stack before creating anything in the cluster', async () => {
    await expect(service.create(input({ devworkspaceValue: 'cobol' }))).rejects.toBeInstanceOf(
      WorkspaceConfigNotFoundError,
    );
    expect(kube.workspaces()).toHaveLength(0);
  });

  it('records a failed metric when the cluster refuses the workspace', async () => {
    kube.failOnce('create:DevWorkspace', new UpstreamError('webhook denied'));
    await expect(service.create(input())).rejects.toBeInstanceOf(UpstreamError);
    const failed = metrics.records.find((r) => r.resourcetype === 'workspace');
    expect(failed?.status).toMatchObject({ failed: true, error: 'webhook denied' });
  });

  it('enforces the total workspace limit', async () => {
    for (const phase of ['Stopped', 'Stopped', 'Stopped']) {
      const ws = await service.create(input());
      kube.setPhase(wsNamespace, ws.id, phase);
    }
    await expect(service.create(input())).rejects.toBeInstanceOf(WorkspaceCountExceededError);
  });

  it('enforces the running workspace limit', async () => {
    const a = await service.create(input());
    const b = await service.create(input());
    kube.setPhase(wsNamespace, a.id, 'Running');
    kube.setPhase(wsNamespace, b.id, 'Running');
    await expect(service.create(input())).rejects.toBeInstanceOf(WorkspaceRunCountExceededError);
  });

  it('counts workspaces without a phase as running', async () => {
    await service.create(input());
    await service.create(input());
    await expect(service.create(input())).rejects.toBeInstanceOf(WorkspaceRunCountExceededError);
  });

  it('does not count stopped or failed workspaces as running', async () => {
    const a = await service.create(input());
    const b = await service.create(input());
    kube.setPhase(wsNamespace, a.id, 'Stopped');
    kube.setPhase(wsNamespace, b.id, 'Failed');
    await expect(service.create(input())).resolves.toBeDefined();
  });
});

describe('list / get', () => {
  it('lists across all of the user’s namespaces and nobody else’s', async () => {
    await service.create(input({ csiid: '1001' }));
    await service.create(input({ csiid: '1002' }));
    kube.seedNamespace('pp2-devspaces-1', 'pp2');
    await kube.create('DevWorkspace', 'pp2-devspaces-1', {
      metadata: { name: 'theirs' },
      spec: { started: false },
    });
    const list = await service.list('pp1');
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.csiid).sort()).toEqual(['1001', '1002']);
  });

  it('gets one workspace and 404s for unknown or foreign ids', async () => {
    const ws = await service.create(input());
    expect((await service.get('pp1', ws.id)).id).toBe(ws.id);
    await expect(service.get('pp1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.get('pp2', ws.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('start / stop', () => {
  it('starts a stopped workspace and records it', async () => {
    const ws = await service.create(input());
    kube.setPhase(wsNamespace, ws.id, 'Stopped');
    await service.start('pp1', ws.id);
    expect(onlyWorkspace().spec?.started).toBe(true);
    expect(metrics.records.at(-1)).toMatchObject({ eventtype: 'start', resourcename: ws.id });
  });

  it('is a no-op for a workspace that is already running or starting', async () => {
    const ws = await service.create(input());
    kube.setPhase(wsNamespace, ws.id, 'Running');
    const before = metrics.records.length;
    await service.start('pp1', ws.id);
    expect(kube.calls).not.toContain('setWorkspaceStarted');
    expect(metrics.records).toHaveLength(before);
  });

  it('refuses to start when the running limit is reached', async () => {
    const a = await service.create(input());
    kube.setPhase(wsNamespace, a.id, 'Stopped');
    const b = await service.create(input());
    kube.setPhase(wsNamespace, b.id, 'Stopped');
    const c = await service.create(input({ csiid: '1002' }));
    kube.setPhase('pp1-devspaces-1002', c.id, 'Stopped');
    kube.setPhase(wsNamespace, a.id, 'Running');
    kube.setPhase(wsNamespace, b.id, 'Running');
    await expect(service.start('pp1', c.id)).rejects.toBeInstanceOf(WorkspaceRunCountExceededError);
  });

  it('stops a workspace and records how long it ran', async () => {
    const ws = await service.create(input());
    kube.setPhase(wsNamespace, ws.id, 'Running');
    clock.advance(90 * 60 * 1000);
    await service.stop('pp1', ws.id);
    expect(onlyWorkspace().spec?.started).toBe(false);
    expect(metrics.records.at(-1)).toMatchObject({ eventtype: 'stop', duration: '1 hour 30 minutes' });
  });

  it('404s for an unknown workspace', async () => {
    await expect(service.stop('pp1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.start('pp1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('records a failed stop', async () => {
    const ws = await service.create(input());
    kube.failOnce('setWorkspaceStarted', new UpstreamError('patch failed'));
    await expect(service.stop('pp1', ws.id)).rejects.toBeInstanceOf(UpstreamError);
    expect(metrics.records.at(-1)?.status).toMatchObject({ failed: true, error: 'patch failed' });
  });
});

describe('delete', () => {
  it('deletes the workspace and records its lifetime', async () => {
    const ws = await service.create(input());
    clock.advance(2 * 60 * 60 * 1000);
    await service.delete('pp1', ws.id);
    expect(kube.workspaces()).toHaveLength(0);
    expect(metrics.records.at(-1)).toMatchObject({
      eventtype: 'delete',
      duration: '2 hours',
      limitcpu: 2,
      storage: 3,
    });
  });

  it('also removes the legacy DevWorkspaceTemplate a workspace contributes', async () => {
    kube.seedNamespace(wsNamespace, 'pp1', '1001');
    await kube.create('DevWorkspaceTemplate', wsNamespace, { metadata: { name: 'legacy-template' } });
    await kube.create('DevWorkspace', wsNamespace, {
      metadata: { name: 'legacy' },
      spec: { contributions: [{ name: 'x', kubernetes: { name: 'legacy-template' } }] },
    });
    await service.delete('pp1', 'legacy');
    expect(kube.objects.size).toBe(0);
  });

  it('404s for an unknown workspace', async () => {
    await expect(service.delete('pp1', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('helpers', () => {
  it('isActive', () => {
    expect(isActive({ status: {} })).toBe(true);
    expect(isActive({})).toBe(true);
    for (const phase of ['Running', 'Starting', 'Stopping'])
      expect(isActive({ status: { phase } })).toBe(true);
    for (const phase of ['Stopped', 'Failed']) expect(isActive({ status: { phase } })).toBe(false);
  });

  it('toWorkspace tolerates a sparse resource', () => {
    expect(toWorkspace({ metadata: { name: 'x', namespace: 'pp1-devspaces-5' } })).toMatchObject({
      id: 'x',
      csiid: '5',
      phase: 'Starting',
      mainUrl: '',
      created: '',
      limitcpu: 0,
    });
  });
});
