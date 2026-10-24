import {
  ANNOTATION_CHE_USERNAME,
  LABEL_COMPONENT,
  LABEL_CSIID,
  LABEL_WORKSPACES_NAMESPACE,
  NETWORK_POLICIES_DEFAULT_CONFIG,
  ORION_LIMIT_RANGE_CONFIG,
  ORION_RESOURCE_QUOTA_CONFIG,
  USER_ROLE_CONFIG,
  WORKSPACES_NAMESPACE_SELECTOR,
} from '../constants/kubernetes-configs.js';
import type { KubeObject, Project } from '../types.js';
import type { KubeGateway } from '../infra/ports.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { silentLogger, type Logger } from '../utils/logger.js';
import { csiidFromWorkspaceNamespace, workspaceNamespace } from '../utils/names.js';
import type { MetricsRecorder } from './MetricsRecorder.js';

export interface NamespaceServiceOptions {
  workspaceProxyUrl?: string;
  emailDomain: string;
}

export interface EnsuredNamespace {
  name: string;
  created: boolean;
}

export class NamespaceService {
  constructor(
    private readonly kube: KubeGateway,
    private readonly recorder: MetricsRecorder,
    private readonly options: NamespaceServiceOptions,
    private readonly logger: Logger = silentLogger,
  ) {}

  /** All workspace namespaces owned by the user (by label and Che username annotation). */
  async listForUser(soeid: string): Promise<KubeObject[]> {
    const all = await this.kube.listNamespaces(WORKSPACES_NAMESPACE_SELECTOR);
    return all.filter((ns) => ns.metadata?.annotations?.[ANNOTATION_CHE_USERNAME] === soeid);
  }

  async listProjects(soeid: string): Promise<Project[]> {
    const namespaces = await this.listForUser(soeid);
    return namespaces.map((ns) => {
      const name = ns.metadata?.name ?? '';
      return {
        name,
        soeid,
        csiid: ns.metadata?.labels?.[LABEL_CSIID] ?? csiidFromWorkspaceNamespace(name) ?? '',
        createdAt: ns.metadata?.creationTimestamp
          ? new Date(ns.metadata.creationTimestamp).toISOString()
          : '',
      };
    });
  }

  /** The namespace must already exist (PATs, git config); never creates one. */
  async require(soeid: string, csiid: string): Promise<string> {
    const name = workspaceNamespace(soeid, csiid);
    const existing = await this.kube.getNamespace(name);
    if (!existing) throw new NotFoundError(`Project '${name}' not found`, 'PROJECT_NOT_FOUND');
    this.assertOwner(existing, soeid);
    return name;
  }

  /** Find the user's namespace for this CSI id, creating and provisioning it when it does not exist. */
  async ensure(soeid: string, csiid: string): Promise<EnsuredNamespace> {
    const name = workspaceNamespace(soeid, csiid);
    const existing = await this.kube.getNamespace(name);
    if (existing) {
      this.assertOwner(existing, soeid);
      return { name, created: false };
    }

    this.logger.info('namespace.creating', { soeid, namespace: name });
    const created = await this.recorder.track(
      { soeid, csiid, eventtype: 'create', resourcetype: 'project', resourcename: name },
      () => this.createAndProvision(soeid, csiid, name),
    );
    return { name, created };
  }

  private async createAndProvision(soeid: string, csiid: string, name: string): Promise<boolean> {
    try {
      await this.kube.createNamespace({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name,
          labels: {
            [LABEL_COMPONENT]: LABEL_WORKSPACES_NAMESPACE,
            'app.kubernetes.io/part-of': 'che.eclipse.org',
            'app.kubernetes.io/managed-by': 'workspace-mgr',
            [LABEL_CSIID]: csiid,
          },
          annotations: { [ANNOTATION_CHE_USERNAME]: soeid },
        },
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        // Another request created it between our read and write; use theirs.
        const raced = await this.kube.getNamespace(name);
        if (raced) {
          this.assertOwner(raced, soeid);
          return false;
        }
      }
      throw error;
    }

    try {
      await this.reconcile(soeid, name);
    } catch (error) {
      this.logger.error('namespace.provision_failed', { soeid, namespace: name, error });
      await this.kube.deleteNamespace(name).catch(() => false);
      throw error;
    }
    return true;
  }

  async reconcile(soeid: string, namespace: string): Promise<void> {
    await this.kube.apply('Role', namespace, USER_ROLE_CONFIG);
    await this.kube.apply('RoleBinding', namespace, {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: {
        name: `devspaces-project-access-${soeid}`,
        labels: { [LABEL_COMPONENT]: 'devspaces-workspace-management' },
      },
      subjects: [{ kind: 'User', name: soeid, apiGroup: 'rbac.authorization.k8s.io' }],
      roleRef: {
        kind: 'Role',
        name: USER_ROLE_CONFIG.metadata?.name,
        apiGroup: 'rbac.authorization.k8s.io',
      },
    });
    await this.kube.apply('ResourceQuota', namespace, ORION_RESOURCE_QUOTA_CONFIG);
    await this.kube.apply('LimitRange', namespace, ORION_LIMIT_RANGE_CONFIG);
    for (const policy of NETWORK_POLICIES_DEFAULT_CONFIG) {
      await this.kube.apply('NetworkPolicy', namespace, policy);
    }
    await this.applyProxyConfig(soeid, namespace);
  }

  private async applyProxyConfig(soeid: string, namespace: string): Promise<void> {
    const proxy = this.options.workspaceProxyUrl;
    if (!proxy) return;
    const noProxy = 'localhost,127.0.0.1,*.svc,*.svc.cluster.local';

    await this.kube.apply('ConfigMap', namespace, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'proxy-env-vars-ws-mgr',
        labels: {
          'controller.devfile.io/mount-to-devworkspace': 'true',
          'controller.devfile.io/watch-configmap': 'true',
        },
        annotations: { 'controller.devfile.io/mount-as': 'env' },
      },
      data: {
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      },
    });

    await this.kube.apply('ConfigMap', namespace, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'workspace-userdata-gitconfig-configmap-ws-mgr',
        labels: {
          'controller.devfile.io/mount-to-devworkspace': 'true',
          'controller.devfile.io/watch-configmap': 'true',
        },
        annotations: {
          'controller.devfile.io/mount-as': 'subpath',
          'controller.devfile.io/mount-path': '/etc/',
        },
      },
      data: {
        gitconfig: `[user]\n  name = ${soeid}\n  email = ${soeid}@${this.options.emailDomain}\n[http]\n  sslVerify = false\n[proxy]\n  http = ${proxy}\n  https = ${proxy}\n`,
      },
    });
  }

  private assertOwner(namespace: KubeObject, soeid: string): void {
    const owner = namespace.metadata?.annotations?.[ANNOTATION_CHE_USERNAME];
    if (owner !== soeid) {
      throw new ConflictError(
        `Namespace '${namespace.metadata?.name}' exists but belongs to another user`,
        'NAMESPACE_OWNERSHIP_MISMATCH',
      );
    }
  }
}
