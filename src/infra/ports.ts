import type { CatalogEntry, DevWorkspaceResource, KubeObject, MetricsRecord } from '../types.js';

export type NamespacedKind =
  | 'Secret'
  | 'ConfigMap'
  | 'ResourceQuota'
  | 'LimitRange'
  | 'Role'
  | 'RoleBinding'
  | 'NetworkPolicy'
  | 'DevWorkspace'
  | 'DevWorkspaceTemplate';

/** Everything the services need from Kubernetes/OpenShift. Implemented by KubeClient and by the in-memory fake. */
export interface KubeGateway {
  applyCluster?(kind: 'ClusterRole' | 'ClusterRoleBinding', body: KubeObject): Promise<KubeObject>;
  listNamespaces(labelSelector?: string): Promise<KubeObject[]>;
  getNamespace(name: string): Promise<KubeObject | null>;
  createNamespace(body: KubeObject): Promise<KubeObject>;
  deleteNamespace(name: string): Promise<boolean>;
  /** OpenShift ProjectRequest; the resulting namespace is returned. */
  createProject(body: KubeObject): Promise<KubeObject>;

  get<T extends KubeObject>(kind: NamespacedKind, namespace: string, name: string): Promise<T | null>;
  list<T extends KubeObject>(kind: NamespacedKind, namespace: string, labelSelector?: string): Promise<T[]>;
  create<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): Promise<T>;
  /** Create the object, or replace it when it already exists. */
  apply<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): Promise<T>;
  /** Returns false when the object was already gone. */
  delete(kind: NamespacedKind, namespace: string, name: string): Promise<boolean>;

  setWorkspaceStarted(namespace: string, name: string, started: boolean): Promise<DevWorkspaceResource>;
  ping(): Promise<void>;
}

export interface MetricsStore {
  insert(record: MetricsRecord): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DevfileRegistry {
  getCatalog(): Promise<CatalogEntry[]>;
  /** Raw devfile YAML for a stack. Throws WorkspaceConfigNotFoundError for unknown stack/version. */
  getDevfile(stack: string, version?: string): Promise<{ yaml: string; version: string }>;
}

export interface NamespaceCreatedEmail {
  soeid: string;
  namespace: string;
}
export interface NamespaceExistsEmail {
  soeid: string;
  newNamespace: string;
  existingNamespace: string;
}
export interface NamespacesDeletedEmail {
  soeid: string;
  namespaces: string[];
}

/** Best-effort user notifications; implementations must never throw. */
export interface Notifier {
  namespaceCreated(event: NamespaceCreatedEmail): Promise<void>;
  namespaceAlreadyExists(event: NamespaceExistsEmail): Promise<void>;
  namespacesDeleted(event: NamespacesDeletedEmail): Promise<void>;
}

/** Looks up a person's first name for greetings; resolves undefined when unknown or unavailable. */
export interface UserDirectory {
  firstName(soeid: string): Promise<string | undefined>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
