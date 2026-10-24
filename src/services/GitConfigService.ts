import type { KubeObject } from '../domain/types.js';
import type { KubeGateway } from '../infra/ports.js';
import { BadRequestError, NotFoundError } from '../utils/errors.js';
import type { MetricsRecorder } from './MetricsRecorder.js';
import type { NamespaceService } from './NamespaceService.js';

export const GITCONFIG_CONFIGMAP = 'workspace-userdata-gitconfig-configmap';
const MAX_CONTENT_BYTES = 64 * 1024;

export interface GitConfigFile {
  name: string;
  namespace: string;
  content: string;
}

export class GitConfigService {
  constructor(
    private readonly kube: KubeGateway,
    private readonly namespaces: NamespaceService,
    private readonly recorder: MetricsRecorder,
  ) {}

  async view(soeid: string, csiid: string): Promise<GitConfigFile> {
    const namespace = await this.namespaces.require(soeid, csiid);
    const configMap = await this.kube.get<KubeObject>('ConfigMap', namespace, GITCONFIG_CONFIGMAP);
    if (!configMap) throw new NotFoundError('Git config not found', 'GITCONFIG_NOT_FOUND');
    return {
      name: GITCONFIG_CONFIGMAP,
      namespace,
      content: (configMap.data as Record<string, string> | undefined)?.['.gitconfig'] ?? '',
    };
  }

  /** Create or replace the user's `~/.gitconfig`. */
  async upsert(soeid: string, csiid: string, content: string): Promise<GitConfigFile> {
    if (content.trim().length === 0) throw new BadRequestError('Git config content must not be empty');
    if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
      throw new BadRequestError('Git config content is too large (max 64 KiB)');
    }
    const namespace = await this.namespaces.require(soeid, csiid);
    const existed = (await this.kube.get('ConfigMap', namespace, GITCONFIG_CONFIGMAP)) !== null;

    await this.recorder.track(
      {
        soeid,
        csiid,
        eventtype: existed ? 'update' : 'create',
        resourcetype: 'gitconfig',
        resourcename: GITCONFIG_CONFIGMAP,
      },
      () =>
        this.kube.apply('ConfigMap', namespace, {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: GITCONFIG_CONFIGMAP,
            labels: {
              'controller.devfile.io/mount-to-devworkspace': 'true',
              'controller.devfile.io/watch-configmap': 'true',
            },
            annotations: {
              'controller.devfile.io/mount-as': 'subpath',
              'controller.devfile.io/mount-path': '/home/user',
            },
          },
          data: { '.gitconfig': content },
        }),
    );
    return { name: GITCONFIG_CONFIGMAP, namespace, content };
  }

  /** Returns false when there was nothing to delete. */
  async delete(soeid: string, csiid: string): Promise<boolean> {
    const namespace = await this.namespaces.require(soeid, csiid);
    return this.recorder.track(
      { soeid, csiid, eventtype: 'delete', resourcetype: 'gitconfig', resourcename: GITCONFIG_CONFIGMAP },
      () => this.kube.delete('ConfigMap', namespace, GITCONFIG_CONFIGMAP),
    );
  }
}
