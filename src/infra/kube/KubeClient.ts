import {
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
} from '@kubernetes/client-node';
import type { DevWorkspaceResource, KubeObject } from '../../domain/types.js';
import { isK8sStatus, toAppError } from '../../utils/k8s-errors.js';
import type { KubeGateway, NamespacedKind } from '../ports.js';

const API_VERSION: Record<NamespacedKind, string> = {
  Secret: 'v1',
  ConfigMap: 'v1',
  ResourceQuota: 'v1',
  LimitRange: 'v1',
  Role: 'rbac.authorization.k8s.io/v1',
  RoleBinding: 'rbac.authorization.k8s.io/v1',
  NetworkPolicy: 'networking.k8s.io/v1',
  DevWorkspace: 'workspace.devfile.io/v1alpha2',
  DevWorkspaceTemplate: 'workspace.devfile.io/v1alpha2',
};

const asK8s = (o: unknown): KubernetesObject => o as KubernetesObject;
const asKube = <T>(o: unknown): T => o as T;

export function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromDefault();
  return kc;
}

/** Kubernetes/OpenShift access through the pod's service account (or a kubeconfig for local runs). */
export class KubeClient implements KubeGateway {
  private readonly core: CoreV1Api;
  private readonly objects: KubernetesObjectApi;

  constructor(kubeConfig: KubeConfig) {
    this.core = kubeConfig.makeApiClient(CoreV1Api);
    this.objects = KubernetesObjectApi.makeApiClient(kubeConfig);
  }

  private async call<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toAppError(context, error);
    }
  }

  private async orNull<T>(context: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      if (isK8sStatus(error, 404)) return null;
      throw toAppError(context, error);
    }
  }

  private header(kind: NamespacedKind, namespace: string, name: string) {
    return { apiVersion: API_VERSION[kind], kind, metadata: { name, namespace } };
  }

  private body<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): KubernetesObject {
    return asK8s({
      ...body,
      apiVersion: API_VERSION[kind],
      kind,
      metadata: { ...body.metadata, namespace },
    });
  }

  async listNamespaces(labelSelector?: string): Promise<KubeObject[]> {
    const res = await this.call('List namespaces', () => this.core.listNamespace({ labelSelector }));
    return asKube<KubeObject[]>(res.items);
  }

  getNamespace(name: string): Promise<KubeObject | null> {
    return this.orNull(`Read namespace '${name}'`, async () =>
      asKube<KubeObject>(await this.core.readNamespace({ name })),
    );
  }

  async createNamespace(body: KubeObject): Promise<KubeObject> {
    const created = await this.call(`Create namespace '${body.metadata?.name}'`, () =>
      this.core.createNamespace({ body: asKube(body) }),
    );
    return asKube<KubeObject>(created);
  }

  async deleteNamespace(name: string): Promise<boolean> {
    const result = await this.orNull(`Delete namespace '${name}'`, () => this.core.deleteNamespace({ name }));
    return result !== null;
  }

  async createProject(body: KubeObject): Promise<KubeObject> {
    const name = body.metadata?.name ?? '';
    const request = asK8s({ ...body, apiVersion: 'project.openshift.io/v1', kind: 'ProjectRequest' });
    const created = await this.call(`Create project '${name}'`, () => this.objects.create(request));
    const result = asKube<KubeObject>(created);
    return result.metadata?.name ? result : { ...result, metadata: { ...result.metadata, name } };
  }

  get<T extends KubeObject>(kind: NamespacedKind, namespace: string, name: string): Promise<T | null> {
    return this.orNull(`Read ${kind} '${name}'`, async () =>
      asKube<T>(await this.objects.read(this.header(kind, namespace, name))),
    );
  }

  async list<T extends KubeObject>(
    kind: NamespacedKind,
    namespace: string,
    labelSelector?: string,
  ): Promise<T[]> {
    const res = await this.call(`List ${kind} in '${namespace}'`, () =>
      this.objects.list(
        API_VERSION[kind],
        kind,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector,
      ),
    );
    return asKube<T[]>(res.items);
  }

  async create<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): Promise<T> {
    const created = await this.call(`Create ${kind} '${body.metadata?.name}'`, () =>
      this.objects.create(this.body(kind, namespace, body)),
    );
    return asKube<T>(created);
  }

  async apply<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): Promise<T> {
    const name = body.metadata?.name ?? '';
    const context = `Apply ${kind} '${name}'`;
    const replaceExisting = async (): Promise<T | null> => {
      const existing = await this.get<T>(kind, namespace, name);
      if (!existing) return null;
      const spec = this.body(kind, namespace, {
        ...body,
        metadata: { ...body.metadata, resourceVersion: existing.metadata?.resourceVersion },
      });
      return asKube<T>(await this.call(context, () => this.objects.replace(spec)));
    };

    const replaced = await replaceExisting();
    if (replaced) return replaced;
    try {
      return asKube<T>(await this.objects.create(this.body(kind, namespace, body)));
    } catch (error) {
      if (isK8sStatus(error, 409)) {
        // Lost a creation race with another request; replace what the winner created.
        const retried = await replaceExisting();
        if (retried) return retried;
      }
      throw toAppError(context, error);
    }
  }

  async delete(kind: NamespacedKind, namespace: string, name: string): Promise<boolean> {
    const result = await this.orNull(`Delete ${kind} '${name}'`, () =>
      this.objects.delete(asK8s(this.header(kind, namespace, name))),
    );
    return result !== null;
  }

  async setWorkspaceStarted(
    namespace: string,
    name: string,
    started: boolean,
  ): Promise<DevWorkspaceResource> {
    const patch = asK8s({ ...this.header('DevWorkspace', namespace, name), spec: { started } });
    const patched = await this.call(`${started ? 'Start' : 'Stop'} DevWorkspace '${name}'`, () =>
      this.objects.patch(patch, undefined, undefined, undefined, undefined, PatchStrategy.MergePatch),
    );
    return asKube<DevWorkspaceResource>(patched);
  }

  async ping(): Promise<void> {
    await this.call('Kubernetes API ping', () => this.core.getAPIResources());
  }
}
