import type { Devfile, DevWorkspaceResource, EditorKey } from '../types.js';
import { buildWorkspaceSetupCommand } from './workspace-setup.js';

export const WORKSPACE_LABELS = {
  csiid: 'devspaces.citi.com/csiid',
  stack: 'devspaces.citi.com/stack',
  managedBy: 'app.kubernetes.io/managed-by',
} as const;

export interface BuildWorkspaceArgs {
  name: string;
  namespace: string;
  csiid: string;
  stack: string;
  stackVersion: string;
  devfile: Devfile;
  editor: EditorKey;
  /** Full editor id as the Dev Spaces dashboard knows it, e.g. `che-incubator/che-code/latest`. */
  editorId: string;
  editorRegistryUrl?: string;
  devSpacesServiceFqdn: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
}

const EDITOR_DISPLAY: Record<EditorKey, string> = {
  vscode: 'Visual Studio Code',
  intellij: 'IntelliJ IDEA',
  goland: 'GoLand',
};

export function buildDevWorkspaceObject(a: BuildWorkspaceArgs): DevWorkspaceResource {
  const projects = [...((a.devfile.projects as unknown[] | undefined) ?? [])];
  if (a.repositoryUrl) {
    const requestedProject = {
      name: 'default-project',
      git: {
        remotes: { origin: a.repositoryUrl },
      },
    };
    const existing = projects.findIndex(
      (project) => (project as { name?: string })?.name === 'default-project',
    );
    if (existing >= 0) projects[existing] = requestedProject;
    else projects.push(requestedProject);
  }

  const template: NonNullable<NonNullable<DevWorkspaceResource['spec']>['template']> = {
    attributes: {
      'controller.devfile.io/devworkspace-config': {
        name: 'devworkspace-config',
        namespace: 'openshift-devspaces',
      },
      'controller.devfile.io/scc': 'container-build',
      'controller.devfile.io/storage-type': 'per-workspace',
    },
    components: a.devfile.components ?? [],
  };
  if (projects.length > 0) template.projects = projects;
  if (Array.isArray(a.devfile.commands)) template.commands = a.devfile.commands;
  if (a.devfile.events) template.events = a.devfile.events;
  const tools = a.devfile.components?.find((component) => component.name === 'tools' && component.container);
  const container = tools ?? a.devfile.components?.find((component) => component.container);
  if (container) {
    const commands = [...(a.devfile.commands ?? [])];
    let setupId = 'workspace-manager-setup';
    while (commands.some((command) => (command as { id?: string })?.id === setupId)) setupId += '-post-start';
    commands.push({
      id: setupId,
      exec: {
        component: container.name,
        commandLine: buildWorkspaceSetupCommand({
          stack: a.stack,
          repositoryUrl: a.repositoryUrl,
          repositoryBranch: a.repositoryBranch,
        }),
        workingDir: '/projects',
      },
    });
    const events = (
      a.devfile.events && typeof a.devfile.events === 'object' ? a.devfile.events : {}
    ) as Record<string, unknown>;
    template.commands = commands;
    template.events = {
      ...events,
      postStart: [...(Array.isArray(events.postStart) ? events.postStart : []), setupId],
    };
  }

  return {
    apiVersion: 'workspace.devfile.io/v1alpha2',
    kind: 'DevWorkspace',
    metadata: {
      name: a.name,
      namespace: a.namespace,
      annotations: {
        dw: a.name,
        workspaceVersion: a.stackVersion,
        workspaceDisplayName: a.devfile.metadata?.displayName ?? a.devfile.metadata?.name ?? a.stack,
        workspaceDescription: a.devfile.metadata?.description ?? '',
        editorDisplayName: EDITOR_DISPLAY[a.editor],
      },
      labels: {
        [WORKSPACE_LABELS.csiid]: a.csiid,
        [WORKSPACE_LABELS.stack]: a.stack,
        [WORKSPACE_LABELS.managedBy]: 'workspace-mgr',
      },
    },
    spec: {
      started: true,
      routingClass: 'che',
      template,
      contributions: [
        {
          name: 'ide',
          uri: `${(a.editorRegistryUrl ?? `${a.devSpacesServiceFqdn.replace(/\/$/, '')}/plugin-registry/v3`).replace(/\/$/, '')}/plugins/${a.editorId}/devfile.yaml`,
        },
      ],
    },
  };
}
