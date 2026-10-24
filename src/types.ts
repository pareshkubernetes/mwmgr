export type EditorKey = 'vscode' | 'intellij' | 'goland';

export type EventType = 'create' | 'delete' | 'start' | 'stop' | 'update' | 'view';

export interface MetricsStatus {
  failed: boolean;
  error: string;
  message: string;
}

export interface MetricsRecord {
  timestamp: Date;
  csiid: string;
  soeid: string;
  eventtype: EventType;
  resourcename: string;
  resourcetype: string;
  status: MetricsStatus;
  useraction: 'user' | 'system';
  limitcpu: number;
  limitmemory: number;
  requestcpu: number;
  requestmemory: number;
  duration: string;
  storage: number;
  workspaceversion: string;
  editorname: string;
}

export interface KubeMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: Date | string;
  deletionTimestamp?: Date | string;
  resourceVersion?: string;
  uid?: string;
}

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: KubeMeta;
  [key: string]: unknown;
}

export interface DevfileComponent {
  name: string;
  container?: {
    image?: string;
    cpuLimit?: string;
    cpuRequest?: string;
    memoryLimit?: string;
    memoryRequest?: string;
    env?: { name: string; value: string }[];
    endpoints?: Record<string, unknown>[];
    volumeMounts?: { name: string; path: string }[];
    [key: string]: unknown;
  };
  volume?: { size?: string; [key: string]: unknown };
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Devfile {
  schemaVersion?: string;
  metadata?: {
    name?: string;
    version?: string;
    displayName?: string;
    description?: string;
    [k: string]: unknown;
  };
  components?: DevfileComponent[];
  commands?: unknown[];
  events?: unknown;
  projects?: unknown[];
  starterProjects?: unknown[];
  [key: string]: unknown;
}

export interface DevWorkspaceResource extends KubeObject {
  spec?: {
    started?: boolean;
    routingClass?: string;
    template?: {
      components?: DevfileComponent[];
      projects?: unknown[];
      commands?: unknown[];
      events?: unknown;
      attributes?: Record<string, unknown>;
    };
    contributions?: { name: string; uri?: string; kubernetes?: { name: string } }[];
  };
  status?: {
    phase?: string;
    mainUrl?: string;
    devworkspaceId?: string;
    message?: string;
    conditions?: { type?: string; status?: string; message?: string; lastTransitionTime?: string }[];
  };
}

export interface Workspace {
  id: string;
  name: string;
  displayName: string;
  description: string;
  namespace: string;
  csiid: string;
  phase: string;
  mainUrl: string;
  editor: string;
  version: string;
  stack: string;
  created: string;
  limitcpu: number;
  limitmemory: number;
  storage: number;
}

export interface Project {
  name: string;
  csiid: string;
  soeid: string;
  createdAt: string;
}

export interface Principal {
  soeid: string;
  role: 'user' | 'admin';
}

export interface CreateWorkspaceInput {
  soeid: string;
  csiid: string;
  devworkspaceValue: string;
  editor: EditorKey;
  stackVersion?: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
}

export interface CatalogVersion {
  version: string;
  default?: boolean;
}

export interface CatalogEntry {
  name: string;
  displayName?: string;
  description?: string;
  icon?: string;
  language?: string;
  projectType?: string;
  tags?: string[];
  versions?: CatalogVersion[];
  [key: string]: unknown;
}
