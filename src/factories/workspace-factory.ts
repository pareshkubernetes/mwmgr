import type { Devfile, DevWorkspaceResource, EditorKey } from '../types.js';

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
  devSpacesServiceFqdn: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
}

const EDITOR_DISPLAY: Record<EditorKey, string> = {
  vscode: 'Visual Studio Code',
  intellij: 'IntelliJ IDEA',
  goland: 'GoLand',
};

function repoName(url: string): string {
  const last = url
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .pop();
  return (last ?? 'project').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export function buildDevWorkspaceObject(a: BuildWorkspaceArgs): DevWorkspaceResource {
  const projects = [...((a.devfile.projects as unknown[] | undefined) ?? [])];
  if (a.repositoryUrl) {
    projects.push({
      name: repoName(a.repositoryUrl),
      git: {
        remotes: { origin: a.repositoryUrl },
        ...(a.repositoryBranch ? { checkoutFrom: { revision: a.repositoryBranch } } : {}),
      },
    });
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
          uri: `${a.devSpacesServiceFqdn}/dashboard/api/editors/devfile?che-editor=${a.editorId}`,
        },
      ],
    },
  };
}
