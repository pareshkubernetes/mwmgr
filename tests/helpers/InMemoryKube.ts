import type { DevWorkspaceResource, KubeObject } from '../../src/types.js';
import type { KubeGateway, NamespacedKind } from '../../src/infra/ports.js';
import { ConflictError, NotFoundError } from '../../src/utils/errors.js';

function matches(labels: Record<string, string> | undefined, selector?: string): boolean {
  if (!selector) return true;
  return selector.split(',').every((term) => {
    const [key, value] = term.split('=');
    return key !== undefined && labels?.[key] === value;
  });
}

/** A tiny stand-in for a cluster: same contract as KubeClient, no network. */
export class InMemoryKube implements KubeGateway {
  readonly namespaces = new Map<string, KubeObject>();
  readonly objects = new Map<string, KubeObject>();
  readonly calls: string[] = [];
  private readonly failures = new Map<string, Error>();
  private version = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Make the next call of `operation` (e.g. `create:DevWorkspace`, `createNamespace`) throw. */
  failOnce(operation: string, error: Error): void {
    this.failures.set(operation, error);
  }

  private enter(operation: string): void {
    this.calls.push(operation);
    const failure = this.failures.get(operation);
    if (failure) {
      this.failures.delete(operation);
      throw failure;
    }
  }

  private stamp<T extends KubeObject>(body: T, namespace?: string): T {
    const copy = structuredClone(body);
    copy.metadata = {
      ...copy.metadata,
      ...(namespace ? { namespace } : {}),
      creationTimestamp: copy.metadata?.creationTimestamp ?? this.now().toISOString(),
      resourceVersion: String(this.version++),
      uid: copy.metadata?.uid ?? `uid-${this.version}`,
    };
    return copy;
  }

  private key(kind: NamespacedKind, namespace: string, name: string): string {
    return `${kind}/${namespace}/${name}`;
  }

  // ---- namespaces --------------------------------------------------------------------------
  async listNamespaces(labelSelector?: string): Promise<KubeObject[]> {
    this.enter('listNamespaces');
    return [...this.namespaces.values()]
      .filter((ns) => matches(ns.metadata?.labels, labelSelector))
      .map((ns) => structuredClone(ns));
  }

  async getNamespace(name: string): Promise<KubeObject | null> {
    this.enter('getNamespace');
    const ns = this.namespaces.get(name);
    return ns ? structuredClone(ns) : null;
  }

  async createNamespace(body: KubeObject): Promise<KubeObject> {
    this.enter('createNamespace');
    const name = body.metadata?.name ?? '';
    if (this.namespaces.has(name)) throw new ConflictError(`namespace ${name} already exists`);
    const created = this.stamp({ ...body, apiVersion: 'v1', kind: 'Namespace' });
    this.namespaces.set(name, created);
    return structuredClone(created);
  }

  async deleteNamespace(name: string): Promise<boolean> {
    this.enter('deleteNamespace');
    const existed = this.namespaces.delete(name);
    for (const key of [...this.objects.keys()]) if (key.split('/')[1] === name) this.objects.delete(key);
    return existed;
  }

  async createProject(body: KubeObject): Promise<KubeObject> {
    this.enter('createProject');
    const name = body.metadata?.name ?? '';
    if (this.namespaces.has(name)) throw new ConflictError(`project ${name} already exists`);
    const created = this.stamp({ ...body, apiVersion: 'project.openshift.io/v1', kind: 'Project' });
    this.namespaces.set(name, created);
    return structuredClone(created);
  }

  // ---- namespaced objects ------------------------------------------------------------------
  async get<T extends KubeObject>(kind: NamespacedKind, namespace: string, name: string): Promise<T | null> {
    this.enter(`get:${kind}`);
    const found = this.objects.get(this.key(kind, namespace, name));
    return found ? (structuredClone(found) as T) : null;
  }

  async list<T extends KubeObject>(
    kind: NamespacedKind,
    namespace: string,
    labelSelector?: string,
  ): Promise<T[]> {
    this.enter(`list:${kind}`);
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${kind}/${namespace}/`))
      .map(([, obj]) => obj)
      .filter((obj) => matches(obj.metadata?.labels, labelSelector))
      .map((obj) => structuredClone(obj) as T);
  }

  async create<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): Promise<T> {
    this.enter(`create:${kind}`);
    if (!this.namespaces.has(namespace)) throw new NotFoundError(`namespace ${namespace} not found`);
    const name = body.metadata?.name ?? '';
    const key = this.key(kind, namespace, name);
    if (this.objects.has(key)) throw new ConflictError(`${kind} ${name} already exists`);
    const created = this.stamp({ ...body, kind }, namespace);
    this.objects.set(key, created);
    return structuredClone(created) as T;
  }

  async apply<T extends KubeObject>(kind: NamespacedKind, namespace: string, body: T): Promise<T> {
    this.enter(`apply:${kind}`);
    if (!this.namespaces.has(namespace)) throw new NotFoundError(`namespace ${namespace} not found`);
    const name = body.metadata?.name ?? '';
    const key = this.key(kind, namespace, name);
    const previous = this.objects.get(key);
    const applied = this.stamp(
      {
        ...body,
        kind,
        metadata: { ...body.metadata, creationTimestamp: previous?.metadata?.creationTimestamp },
      },
      namespace,
    );
    this.objects.set(key, applied);
    return structuredClone(applied) as T;
  }

  async delete(kind: NamespacedKind, namespace: string, name: string): Promise<boolean> {
    this.enter(`delete:${kind}`);
    return this.objects.delete(this.key(kind, namespace, name));
  }

  async setWorkspaceStarted(
    namespace: string,
    name: string,
    started: boolean,
  ): Promise<DevWorkspaceResource> {
    this.enter('setWorkspaceStarted');
    const key = this.key('DevWorkspace', namespace, name);
    const dw = this.objects.get(key) as DevWorkspaceResource | undefined;
    if (!dw) throw new NotFoundError(`DevWorkspace ${name} not found`);
    dw.spec = { ...dw.spec, started };
    dw.status = { ...dw.status, phase: started ? 'Starting' : 'Stopping' };
    return structuredClone(dw);
  }

  async ping(): Promise<void> {
    this.enter('ping');
  }

  // ---- test helpers ------------------------------------------------------------------------
  /** Simulate the DevWorkspace controller moving a workspace to a phase. */
  setPhase(namespace: string, name: string, phase: string, mainUrl?: string): void {
    const dw = this.objects.get(this.key('DevWorkspace', namespace, name)) as
      DevWorkspaceResource | undefined;
    if (!dw) throw new Error(`no such DevWorkspace ${namespace}/${name}`);
    dw.status = {
      ...dw.status,
      phase,
      ...(mainUrl ? { mainUrl } : {}),
      conditions: [
        {
          type: 'Started',
          status: phase === 'Running' ? 'True' : 'False',
          lastTransitionTime: this.now().toISOString(),
        },
      ],
    };
  }

  workspaces(namespace?: string): DevWorkspaceResource[] {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith('DevWorkspace/') && (!namespace || key.split('/')[1] === namespace))
      .map(([, obj]) => obj as DevWorkspaceResource);
  }

  seedNamespace(name: string, soeid: string, csiid = '1'): void {
    this.namespaces.set(name, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name,
        labels: { 'app.kubernetes.io/component': 'workspaces-namespace', 'devspaces.citi.com/csiid': csiid },
        annotations: { 'che.eclipse.org/username': soeid },
        creationTimestamp: this.now().toISOString(),
      },
    });
  }
}
