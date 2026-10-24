import { ANNOTATION_CHE_USERNAME } from '../constants/kubernetes-configs.js';
import type { KubeObject } from '../types.js';
import type { KubeGateway } from '../infra/ports.js';
import type { NamespaceService } from './NamespaceService.js';
import type { DeploymentNamespaceService } from './DeploymentNamespaceService.js';
import type { Logger } from '../utils/logger.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { deploymentNamespace, parseCsiid, parseSoeid } from '../utils/names.js';

export interface SupportInput {
  soeid: string;
  csiid: string;
  target: 'workspace' | 'deployment';
  resources?: (KubeObject & {
    kind: 'Role' | 'RoleBinding' | 'ResourceQuota' | 'LimitRange' | 'ClusterRole' | 'ClusterRoleBinding';
  })[];
}
export class SupportService {
  constructor(
    private readonly dependencies: {
      kube: KubeGateway;
      deployKube: KubeGateway;
      namespaces: NamespaceService;
      deployments: DeploymentNamespaceService;
      logger: Logger;
    },
  ) {}
  async apply(body: SupportInput) {
    const soeid = parseSoeid(body.soeid);
    const csiid = parseCsiid(body.csiid);
    const kube = body.target === 'workspace' ? this.dependencies.kube : this.dependencies.deployKube;
    const namespace =
      body.target === 'workspace'
        ? await this.dependencies.namespaces.require(soeid, csiid)
        : deploymentNamespace(soeid, csiid);
    const existing = await kube.getNamespace(namespace);
    if (!existing) throw new NotFoundError('Project not found');
    if (existing.metadata?.annotations?.[ANNOTATION_CHE_USERNAME] !== soeid)
      throw new ConflictError('Project belongs to another user');
    if (!body.resources) {
      if (body.target === 'workspace') await this.dependencies.namespaces.reconcile(soeid, namespace);
      else await this.dependencies.deployments.reconcile(soeid, namespace);
    } else {
      for (const resource of body.resources) {
        const object = resource as KubeObject;
        if (resource.kind === 'ClusterRole' || resource.kind === 'ClusterRoleBinding') {
          if (!kube.applyCluster) throw new ConflictError('Cluster resource updates unavailable');
          await kube.applyCluster(resource.kind, object);
        } else await kube.apply(resource.kind, namespace, object);
      }
    }
    this.dependencies.logger.info('support.resources_applied', { soeid, namespace, target: body.target });
    return { namespace, target: body.target, message: 'Resources reconciled successfully.' };
  }
}
