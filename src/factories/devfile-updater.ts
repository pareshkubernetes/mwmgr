import { load } from 'js-yaml';
import type { Devfile, EditorKey } from '../types.js';
import { BadRequestError } from '../utils/errors.js';

interface EditorProfile {
  serverComponentName: string;
  serverPath: string;
  partOf: string;
  targetPort: number;
}

/** JetBrains editors need their server wired into the stack's `tools` container; VS Code needs nothing. */
const PROFILES: Record<EditorKey, EditorProfile | null> = {
  vscode: null,
  intellij: {
    serverComponentName: 'che-idea-server',
    serverPath: '/che-idea-server',
    partOf: 'che-idea-server.eclipse.org',
    targetPort: 2222,
  },
  goland: {
    serverComponentName: 'che-goland-server',
    serverPath: '/che-goland-server',
    partOf: 'che-goland-server.eclipse.org',
    targetPort: 3400,
  },
};

export const DEFAULT_HOME_VOLUME_SIZE = '10Gi';

export function parseDevfile(yamlText: string): Devfile {
  let parsed: unknown;
  try {
    parsed = load(yamlText);
  } catch (error) {
    throw new BadRequestError(`Devfile is not valid YAML: ${(error as Error).message}`, 'INVALID_DEVFILE');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('Devfile must be a YAML mapping', 'INVALID_DEVFILE');
  }
  const devfile = parsed as Devfile;
  if (!Array.isArray(devfile.components)) {
    throw new BadRequestError('Devfile has no components', 'INVALID_DEVFILE');
  }
  return devfile;
}

/** Returns a modified deep copy; the input is never mutated. */
export function applyEditorProfile(
  devfile: Devfile,
  editor: EditorKey,
  homeVolumeSize = DEFAULT_HOME_VOLUME_SIZE,
): Devfile {
  const updated = structuredClone(devfile);
  const profile = PROFILES[editor];
  if (!profile) return updated;

  delete updated.commands;
  delete updated.events;

  const components = updated.components ?? [];
  const tools = components.find((c) => c.name === 'tools');
  if (tools?.container) {
    if (tools.container.volumeMounts) {
      tools.container.volumeMounts = tools.container.volumeMounts.filter((vm) => vm.name !== 'venv');
      const editorMount = tools.container.volumeMounts.find((vm) => vm.name === 'checode');
      if (editorMount) {
        editorMount.name = profile.serverComponentName;
        editorMount.path = profile.serverPath;
      }
    }
    delete tools.container.env;
    tools.container.endpoints = [
      {
        attributes: {
          cookiesAuthEnabled: true,
          discoverable: false,
          type: 'main',
          urlRewriteSupported: true,
        },
        exposure: 'public',
        name: profile.serverComponentName,
        protocol: 'https',
        secure: true,
        targetPort: profile.targetPort,
      },
    ];
    tools.attributes = { ...tools.attributes, 'app.kubernetes.io/part-of': profile.partOf };
  }

  updated.components = components.filter((c) => !(c.name === 'venv' && c.volume !== undefined));

  const editorVolume = updated.components.find((c) => c.name === 'checode' && c.volume !== undefined);
  if (editorVolume) editorVolume.name = profile.serverComponentName;

  const home = updated.components.find((c) => c.name === 'home' && c.volume !== undefined);
  if (home?.volume) home.volume.size = homeVolumeSize;

  return updated;
}
