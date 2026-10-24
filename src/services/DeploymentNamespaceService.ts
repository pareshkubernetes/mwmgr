import {
  ANNOTATION_CHE_USERNAME,
  BUILDER_ROLE_CONFIG,
  DEPLOYER_ROLE_CONFIG,
  DEPLOYMENT_LIMIT_RANGE_DEFAULT_CONFIG,
  DEPLOYMENT_RESOURCE_QUOTA_COMPUTE_CONFIG,
  DEPLOYMENT_RESOURCE_QUOTA_STORAGE_CONFIG,
  LABEL_COMPONENT,
  LABEL_CSIID,
  LABEL_DEPLOYMENT_NAMESPACE,
} from '../constants/kubernetes-configs.js';
import type { KubeObject } from '../types.js';
import type { KubeGateway, Notifier } from '../infra/ports.js';
import { errorMessage } from '../utils/errors.js';
import { silentLogger, type Logger } from '../utils/logger.js';
import { csiidFromDeploymentNamespace, deploymentNamespace } from '../utils/names.js';
import type { MetricsRecorder } from './MetricsRecorder.js';

export interface DeploymentEnsureResult {
  exists: boolean;
  name: string;
}

export interface DeploymentDeleteResult {
  exists: boolean;
  deleted: string[];
  failed: string[];
  message: string;
}

export class DeploymentNamespaceService {
  constructor(
    private readonly kube: KubeGateway,
    private readonly recorder: MetricsRecorder,
    private readonly notifier: Notifier,
    private readonly requester: string,
    private readonly logger: Logger = silentLogger,
  ) {}

  async list(soeid: string): Promise<string[]> {
    const pattern = new RegExp(`^${soeid}-devspaces-deploy-\\d+$`);
    const all = await this.kube.listNamespaces();
    return all.map((ns) => ns.metadata?.name ?? '').filter((name) => pattern.test(name));
  }

  /** Returns the existing deployment project for this CSI id, or creates and provisions a new one. */
  async ensure(soeid: string, csiid: string): Promise<DeploymentEnsureResult> {
    const desired = deploymentNamespace(soeid, csiid);
    if (await this.kube.getNamespace(desired)) {
      await this.notifier.namespaceAlreadyExists({
        soeid,
        newNamespace: desired,
        existingNamespace: desired,
      });
      return { exists: true, name: desired };
    }

    const actual = await this.recorder.track(
      { soeid, csiid, eventtype: 'create', resourcetype: 'deployment_namespace', resourcename: desired },
      () => this.createAndProvision(soeid, csiid, desired),
    );
    await this.notifier.namespaceCreated({ soeid, namespace: actual });
    return { exists: false, name: actual };
  }

  private async createAndProvision(soeid: string, csiid: string, desired: string): Promise<string> {
    const project = await this.kube.createProject({
      metadata: {
        name: desired,
        labels: {
          [LABEL_COMPONENT]: LABEL_DEPLOYMENT_NAMESPACE,
          'app.kubernetes.io/managed-by': 'devspaces-support-team',
          'devspaces.citi.com/purpose': 'deployment-resource-management',
          [LABEL_CSIID]: csiid,
        },
        annotations: {
          [ANNOTATION_CHE_USERNAME]: soeid,
          'devspaces.citi.com/creator': 'workspace-manager-automation',
          'openshift.io/requester': this.requester,
          'openshift.io/display-name': `DevSpaces Deployment Project for User ${soeid} [CSIID: ${csiid}]`,
          'openshift.io/description': `Temporary deployment testing project for user ${soeid} [CSIID: ${csiid}], removable by DevSpaces support`,
        },
      },
    });
    const name = project.metadata?.name ?? desired;

    await this.reconcile(soeid, name);
    this.logger.success('deployment_namespace.created', { soeid, namespace: name });
    return name;
  }

  private async grantAccess(soeid: string, namespace: string): Promise<void> {
    for (const role of [BUILDER_ROLE_CONFIG, DEPLOYER_ROLE_CONFIG]) {
      const roleName = role.metadata?.name ?? '';
      await this.kube.apply('Role', namespace, role);
      await this.kube.apply('RoleBinding', namespace, this.binding(soeid, namespace, roleName));
    }
  }

  async reconcile(soeid: string, namespace: string): Promise<void> {
    await this.kube.apply('ResourceQuota', namespace, DEPLOYMENT_RESOURCE_QUOTA_COMPUTE_CONFIG);
    await this.kube.apply('LimitRange', namespace, DEPLOYMENT_LIMIT_RANGE_DEFAULT_CONFIG);
    await this.kube.apply('ResourceQuota', namespace, DEPLOYMENT_RESOURCE_QUOTA_STORAGE_CONFIG);
    await this.grantAccess(soeid, namespace);
  }

  private binding(soeid: string, namespace: string, roleName: string): KubeObject {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: `${roleName}-${soeid}-binding` },
      subjects: [
        { kind: 'User', name: soeid, apiGroup: 'rbac.authorization.k8s.io' },
        { kind: 'ServiceAccount', name: 'default', namespace },
      ],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: roleName },
    };
  }

  async delete(soeid: string): Promise<DeploymentDeleteResult> {
    const names = await this.list(soeid);
    if (names.length === 0) {
      return { exists: false, deleted: [], failed: [], message: 'No deployment namespaces found for user.' };
    }

    const deleted: string[] = [];
    const failed: string[] = [];
    for (const name of names) {
      try {
        await this.recorder.track(
          {
            soeid,
            csiid: csiidFromDeploymentNamespace(name) ?? '',
            eventtype: 'delete',
            resourcetype: 'deployment_namespace',
            resourcename: name,
          },
          () => this.kube.deleteNamespace(name),
        );
        deleted.push(name);
      } catch (error) {
        this.logger.error('deployment_namespace.delete_failed', {
          soeid,
          namespace: name,
          error: errorMessage(error),
        });
        failed.push(name);
      }
    }

    if (deleted.length > 0) await this.notifier.namespacesDeleted({ soeid, namespaces: deleted });

    const parts: string[] = [];
    if (deleted.length > 0)
      parts.push(`Deleted ${deleted.length} deployment namespace(s): ${deleted.join(', ')}`);
    if (failed.length > 0) parts.push(`Failed to delete ${failed.length}: ${failed.join(', ')}`);
    return { exists: deleted.length > 0, deleted, failed, message: parts.join('. ') };
  }
}
