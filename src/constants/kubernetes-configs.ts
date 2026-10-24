import type { KubeObject } from '../domain/types.js';

export const LABEL_COMPONENT = 'app.kubernetes.io/component';
export const LABEL_WORKSPACES_NAMESPACE = 'workspaces-namespace';
export const LABEL_DEPLOYMENT_NAMESPACE = 'devspaces-deployment';
export const ANNOTATION_CHE_USERNAME = 'che.eclipse.org/username';
export const LABEL_CSIID = 'devspaces.citi.com/csiid';

export const WORKSPACES_NAMESPACE_SELECTOR = `${LABEL_COMPONENT}=${LABEL_WORKSPACES_NAMESPACE}`;
export const DEPLOYMENT_NAMESPACE_SELECTOR = `${LABEL_COMPONENT}=${LABEL_DEPLOYMENT_NAMESPACE}`;

// ---------------------------------------------------------------------------------------------
// Workspace namespaces
// ---------------------------------------------------------------------------------------------

export const ORION_RESOURCE_QUOTA_CONFIG: KubeObject = {
  apiVersion: 'v1',
  kind: 'ResourceQuota',
  metadata: { name: 'compute-resources' },
  spec: {
    hard: {
      'limits.cpu': '8',
      'limits.memory': '20Gi',
      pods: '5',
      'requests.cpu': '8',
      'requests.memory': '20Gi',
    },
    scopes: ['NotTerminating'],
  },
};

export const ORION_LIMIT_RANGE_CONFIG: KubeObject = {
  apiVersion: 'v1',
  kind: 'LimitRange',
  metadata: { name: 'default-limits' },
  spec: {
    limits: [
      {
        type: 'Container',
        max: { cpu: '3500m', memory: '9728Mi' },
        default: { cpu: '500m', memory: '500Mi' },
        defaultRequest: { cpu: '100m', memory: '500Mi' },
      },
      { type: 'Pod', max: { cpu: '3500m', memory: '9728Mi' } },
    ],
  },
};

const networkPolicy = (name: string, from: Record<string, unknown>): KubeObject => ({
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: { name },
  spec: { podSelector: {}, ingress: [{ from: [from] }], policyTypes: ['Ingress'] },
});

export const NETWORK_POLICIES_DEFAULT_CONFIG: KubeObject[] = [
  networkPolicy('allow-from-openshift-devspaces', {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'openshift-devspaces' } },
  }),
  networkPolicy('allow-from-openshift-ingress', {
    namespaceSelector: { matchLabels: { 'network.openshift.io/policy-group': 'ingress' } },
  }),
  networkPolicy('allow-from-openshift-monitoring', {
    namespaceSelector: { matchLabels: { 'network.openshift.io/policy-group': 'monitoring' } },
  }),
  networkPolicy('allow-from-same-namespace', { podSelector: {} }),
  networkPolicy('allow-from-workspaces-namespaces', {
    podSelector: {},
    namespaceSelector: { matchLabels: { [LABEL_COMPONENT]: LABEL_WORKSPACES_NAMESPACE } },
  }),
];

/** What a user may do in their own workspace namespace. */
export const USER_ROLE_CONFIG: KubeObject = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'Role',
  metadata: { name: 'devspaces-user-role' },
  rules: [
    {
      apiGroups: ['workspace.devfile.io'],
      resources: ['devworkspaces', 'devworkspacetemplates'],
      verbs: ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete'],
    },
    {
      apiGroups: [''],
      resources: ['pods', 'pods/log', 'services', 'configmaps', 'persistentvolumeclaims'],
      verbs: ['get', 'list', 'watch'],
    },
    { apiGroups: [''], resources: ['pods/exec', 'pods/portforward'], verbs: ['create', 'get'] },
    { apiGroups: [''], resources: ['events'], verbs: ['get', 'list', 'watch'] },
  ],
};

// ---------------------------------------------------------------------------------------------
// Deployment (build / deploy) namespaces
// ---------------------------------------------------------------------------------------------

export const DEPLOYMENT_RESOURCE_QUOTA_COMPUTE_CONFIG: KubeObject = {
  apiVersion: 'v1',
  kind: 'ResourceQuota',
  metadata: { name: 'compute-resources' },
  spec: {
    hard: {
      'limits.cpu': '4500m',
      'limits.memory': '25Gi',
      pods: '3',
      'requests.cpu': '4500m',
      'requests.memory': '25Gi',
    },
    scopes: ['NotTerminating'],
  },
};

export const DEPLOYMENT_LIMIT_RANGE_DEFAULT_CONFIG: KubeObject = {
  apiVersion: 'v1',
  kind: 'LimitRange',
  metadata: { name: 'default-limits' },
  spec: {
    limits: [
      {
        type: 'Container',
        max: { cpu: '2', memory: '8Gi' },
        default: { cpu: '500m', memory: '500Mi' },
        defaultRequest: { cpu: '100m', memory: '500Mi' },
      },
    ],
  },
};

export const DEPLOYMENT_RESOURCE_QUOTA_STORAGE_CONFIG: KubeObject = {
  apiVersion: 'v1',
  kind: 'ResourceQuota',
  metadata: { name: 'storage-quota' },
  spec: {
    hard: {
      'dell-csm-sc.storageclass.storage.k8s.io/requests.storage': '24Gi',
      'sc-ontap-nas.storageclass.storage.k8s.io/requests.storage': '50Gi',
    },
  },
};

const ALL_VERBS = ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete'];

export const BUILDER_ROLE_CONFIG: KubeObject = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'Role',
  metadata: { name: 'devspaces-builder-role' },
  rules: [
    {
      apiGroups: ['build.openshift.io'],
      resources: ['buildconfigs', 'builds', 'builds/log'],
      verbs: ALL_VERBS,
    },
    {
      apiGroups: ['build.openshift.io'],
      resources: ['buildconfigs/instantiate', 'buildconfigs/instantiatebinary', 'builds/clone'],
      verbs: ['create', 'get'],
    },
    {
      apiGroups: [''],
      resources: ['pods', 'pods/log', 'configmaps', 'secrets', 'serviceaccounts'],
      verbs: ALL_VERBS,
    },
    { apiGroups: ['project.openshift.io'], resources: ['projects'], verbs: ['list', 'get', 'watch'] },
    { apiGroups: [''], resources: ['namespaces'], verbs: ['list', 'get', 'watch'] },
    { apiGroups: [''], resources: ['pods/exec', 'pods/portforward'], verbs: ['create', 'get'] },
    { apiGroups: [''], resources: ['events'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['events.k8s.io'], resources: ['events'], verbs: ['get', 'list', 'watch'] },
  ],
};

export const DEPLOYER_ROLE_CONFIG: KubeObject = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'Role',
  metadata: { name: 'devspaces-deployer-role' },
  rules: [
    { apiGroups: ['apps'], resources: ['deployments', 'replicasets', 'statefulsets'], verbs: ALL_VERBS },
    {
      apiGroups: [''],
      resources: ['pods', 'pods/log', 'services', 'persistentvolumeclaims', 'configmaps', 'secrets'],
      verbs: ALL_VERBS,
    },
    { apiGroups: [''], resources: ['pods/exec', 'pods/portforward'], verbs: ['create', 'get'] },
    { apiGroups: ['route.openshift.io'], resources: ['routes'], verbs: ALL_VERBS },
  ],
};
