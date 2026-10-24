import type { AppConfig } from '../config/env.js';
import type { CreateWorkspaceInput, DevWorkspaceResource, EditorKey, Workspace } from '../types.js';
import { applyEditorProfile, parseDevfile } from '../factories/devfile-updater.js';
import { buildDevWorkspaceObject, WORKSPACE_LABELS } from '../factories/workspace-factory.js';
import { systemClock, type Clock, type DevfileRegistry, type KubeGateway } from '../infra/ports.js';
import {
  NotFoundError,
  WorkspaceCountExceededError,
  WorkspaceRunCountExceededError,
} from '../utils/errors.js';
import { silentLogger, type Logger } from '../utils/logger.js';
import { cleanWorkspaceName, csiidFromWorkspaceNamespace } from '../utils/names.js';
import { summarizeComponents } from '../utils/resources.js';
import { durationSince } from '../utils/timestamp.js';
import type { MetricsRecorder } from './MetricsRecorder.js';
import type { NamespaceService } from './NamespaceService.js';

export interface WorkspaceServiceOptions {
  limits: AppConfig['limits'];
  editors: AppConfig['devreg']['editors'];
  editorRegistryUrl?: string;
  devSpacesServiceFqdn: string;
}

const ACTIVE_PHASES = new Set(['Running', 'Starting', 'Stopping']);

/** Running, starting, stopping — or not yet reporting a phase — all still hold cluster resources. */
export const isActive = (dw: DevWorkspaceResource): boolean =>
  !dw.status?.phase || ACTIVE_PHASES.has(dw.status.phase);

export function toWorkspace(dw: DevWorkspaceResource): Workspace {
  const meta = dw.metadata ?? {};
  const annotations = meta.annotations ?? {};
  const namespace = meta.namespace ?? '';
  const resources = summarizeComponents(dw.spec?.template?.components);
  return {
    id: meta.name ?? '',
    name: meta.name ?? '',
    displayName: annotations.workspaceDisplayName ?? meta.name ?? '',
    description: annotations.workspaceDescription ?? '',
    namespace,
    csiid: meta.labels?.[WORKSPACE_LABELS.csiid] ?? csiidFromWorkspaceNamespace(namespace) ?? '',
    phase: dw.status?.phase ?? 'Starting',
    mainUrl: dw.status?.mainUrl ?? '',
    editor: annotations.editorDisplayName ?? '',
    version: annotations.workspaceVersion ?? '',
    stack: meta.labels?.[WORKSPACE_LABELS.stack] ?? '',
    created: meta.creationTimestamp ? new Date(meta.creationTimestamp).toISOString() : '',
    limitcpu: resources.limitcpu,
    limitmemory: resources.limitmemory,
    storage: resources.storage,
  };
}

/** When the workspace last became ready; falls back to creation time. */
function runningSince(dw: DevWorkspaceResource): Date | string | undefined {
  const ready = dw.status?.conditions?.find(
    (c) => (c.type === 'Started' || c.type === 'Ready') && c.status === 'True',
  );
  return ready?.lastTransitionTime ?? dw.metadata?.creationTimestamp;
}

export class WorkspaceService {
  constructor(
    private readonly kube: KubeGateway,
    private readonly namespaces: NamespaceService,
    private readonly registry: DevfileRegistry,
    private readonly recorder: MetricsRecorder,
    private readonly options: WorkspaceServiceOptions,
    private readonly clock: Clock = systemClock,
    private readonly logger: Logger = silentLogger,
  ) {}

  private async listResources(soeid: string): Promise<DevWorkspaceResource[]> {
    const namespaces = await this.namespaces.listForUser(soeid);
    const lists = await Promise.all(
      namespaces.map((ns) => this.kube.list<DevWorkspaceResource>('DevWorkspace', ns.metadata?.name ?? '')),
    );
    return lists.flat();
  }

  async list(soeid: string): Promise<Workspace[]> {
    return (await this.listResources(soeid)).map(toWorkspace);
  }

  private async find(soeid: string, id: string): Promise<DevWorkspaceResource> {
    const found = (await this.listResources(soeid)).find((dw) => dw.metadata?.name === id);
    if (!found) throw new NotFoundError(`Workspace '${id}' not found`, 'WORKSPACE_NOT_FOUND');
    return found;
  }

  async get(soeid: string, id: string): Promise<Workspace> {
    return toWorkspace(await this.find(soeid, id));
  }

  private assertCanRunAnother(all: DevWorkspaceResource[]): void {
    const active = all.filter(isActive).length;
    if (active >= this.options.limits.maxRunning) {
      throw new WorkspaceRunCountExceededError(
        `You already have ${active} running workspace(s); the limit is ${this.options.limits.maxRunning}. Stop one first.`,
      );
    }
  }

  private assertCanCreateAnother(all: DevWorkspaceResource[]): void {
    if (all.length >= this.options.limits.maxTotal) {
      throw new WorkspaceCountExceededError(
        `You already have ${all.length} workspace(s); the limit is ${this.options.limits.maxTotal}. Delete one first.`,
      );
    }
    this.assertCanRunAnother(all);
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const { soeid, csiid } = input;
    if (!input.repositoryUrl)
      this.logger.info('workspace.repository_skipped', {
        soeid,
        csiid,
        reason:
          'No repositoryUrl supplied; creating the workspace from the stack without adding a repository.',
      });
    else if (!input.repositoryBranch)
      this.logger.info('workspace.repository_default_branch', {
        soeid,
        csiid,
        reason: 'No repositoryCheckoutBranch supplied; using the repository default branch.',
      });
    this.assertCanCreateAnother(await this.listResources(soeid));

    const { name: namespace } = await this.namespaces.ensure(soeid, csiid);
    this.logger.info('workspace.creating', { soeid, namespace, stack: input.devworkspaceValue });
    const { yaml, version } = await this.registry.getDevfile(input.devworkspaceValue, input.stackVersion);
    const devfile = applyEditorProfile(parseDevfile(yaml), input.editor);
    const body = buildDevWorkspaceObject({
      name: cleanWorkspaceName(input.devworkspaceValue),
      namespace,
      csiid,
      stack: input.devworkspaceValue,
      stackVersion: version,
      devfile,
      editor: input.editor,
      editorId: this.editorId(input.editor),
      editorRegistryUrl: this.options.editorRegistryUrl,
      devSpacesServiceFqdn: this.options.devSpacesServiceFqdn,
      repositoryUrl: input.repositoryUrl,
      repositoryBranch: input.repositoryBranch,
    });

    const created = await this.recorder.track(
      {
        soeid,
        csiid,
        eventtype: 'create',
        resourcetype: 'workspace',
        resourcename: body.metadata?.name ?? '',
        workspaceversion: version,
        editorname: input.editor,
        ...summarizeComponents(devfile.components),
      },
      () => this.kube.create<DevWorkspaceResource>('DevWorkspace', namespace, body),
    );
    this.logger.success('workspace.created', {
      soeid,
      namespace,
      workspace: created.metadata?.name,
      version,
      editor: input.editor,
    });
    return toWorkspace(created);
  }

  async start(soeid: string, id: string): Promise<Workspace> {
    const dw = await this.find(soeid, id);
    if (dw.status?.phase === 'Running' || dw.status?.phase === 'Starting') return toWorkspace(dw);
    this.assertCanRunAnother(await this.listResources(soeid));
    return this.setStarted(soeid, dw, true);
  }

  async stop(soeid: string, id: string): Promise<Workspace> {
    const dw = await this.find(soeid, id);
    return this.setStarted(soeid, dw, false);
  }

  private async setStarted(soeid: string, dw: DevWorkspaceResource, started: boolean): Promise<Workspace> {
    const namespace = dw.metadata?.namespace ?? '';
    const name = dw.metadata?.name ?? '';
    this.logger.info(started ? 'workspace.starting' : 'workspace.stopping', {
      soeid,
      namespace,
      workspace: name,
    });
    const resources = summarizeComponents(dw.spec?.template?.components);
    const patched = await this.recorder.track(
      {
        soeid,
        csiid: toWorkspace(dw).csiid,
        eventtype: started ? 'start' : 'stop',
        resourcetype: 'workspace',
        resourcename: name,
        workspaceversion: dw.metadata?.annotations?.workspaceVersion ?? '',
        editorname: dw.metadata?.annotations?.editorDisplayName ?? '',
        duration: started ? '0 seconds' : durationSince(runningSince(dw), this.clock.now()),
        ...resources,
      },
      () => this.kube.setWorkspaceStarted(namespace, name, started),
    );
    this.logger.success(started ? 'workspace.started' : 'workspace.stopped', {
      soeid,
      namespace,
      workspace: name,
    });
    if (!started)
      this.logger.info('workspace.duration', {
        soeid,
        workspace: name,
        duration: durationSince(runningSince(dw), this.clock.now()),
      });
    return toWorkspace({ ...dw, ...patched, metadata: { ...dw.metadata, ...patched.metadata } });
  }

  async delete(soeid: string, id: string): Promise<void> {
    const dw = await this.find(soeid, id);
    const namespace = dw.metadata?.namespace ?? '';
    const name = dw.metadata?.name ?? '';
    this.logger.info('workspace.deleting', { soeid, namespace, workspace: name });
    const resources = summarizeComponents(dw.spec?.template?.components);

    await this.recorder.track(
      {
        soeid,
        csiid: toWorkspace(dw).csiid,
        eventtype: 'delete',
        resourcetype: 'workspace',
        resourcename: name,
        workspaceversion: dw.metadata?.annotations?.workspaceVersion ?? '',
        editorname: dw.metadata?.annotations?.editorDisplayName ?? '',
        duration: durationSince(dw.metadata?.creationTimestamp, this.clock.now()),
        ...resources,
      },
      async () => {
        await this.kube.delete('DevWorkspace', namespace, name);
        // Workspaces created by the legacy flow reference a separate DevWorkspaceTemplate.
        for (const contribution of dw.spec?.contributions ?? []) {
          if (contribution.kubernetes?.name) {
            await this.kube.delete('DevWorkspaceTemplate', namespace, contribution.kubernetes.name);
          }
        }
      },
    );
    this.logger.success('workspace.deleted', { soeid, namespace, workspace: name });
  }

  private editorId(editor: EditorKey): string {
    return this.options.editors[editor];
  }
}
