import { z } from 'zod';

const flag = (def: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const intFrom = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  PORT: intFrom(3050),
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  SECRET_KEY: z.string().min(16, 'SECRET_KEY must be at least 16 characters'),
  ADMIN_USERNAME: z.string().min(1, 'ADMIN_USERNAME is required'),
  ADMIN_PASSWORD: z.string().min(1, 'ADMIN_PASSWORD is required'),
  JWT_EXPIRES_IN: z.string().default('60d'),
  LEGACY_UNVERSIONED_ROUTES: flag('true'),

  CLUSTER_API_URL: z.string().default(''),
  // Optional second cluster for the build/deploy projects; when unset the same cluster is used.
  DEPLOY_CLUSTER_API_URL: z.string().optional(),
  // Explicit bearer tokens. When unset they are found by name: devSpacesClusterToken<id> / devOpsToken<id>.
  CLUSTER_TOKEN: z.string().optional(),
  DEPLOY_CLUSTER_TOKEN: z.string().optional(),
  KUBECONFIG_PATH: z.string().optional(),
  DEPLOY_PROJECT_REQUESTER: z.string().default('devspaces-support-team'),
  // When unset: https://devspaces.apps.<rest of the CLUSTER_API_URL host>
  DEV_SPACES_SERVICE_FQDN: z.string().optional(),

  DEVREG_URL: z.string().min(1, 'DEVREG_URL is required'),
  // Editor ids as the Dev Spaces dashboard knows them, e.g. che-incubator/che-code/latest (a bare name such as
  // `che-code` is accepted and expanded).
  EDITOR_VSCODE: z.string().default('che-incubator/che-code/latest'),
  EDITOR_INTELLIJ: z.string().default('che-incubator/che-idea/latest'),
  EDITOR_GOLAND: z.string().default('che-incubator/che-goland/latest'),
  WORKSPACE_PROXY_URL: z.string().optional(),

  MAX_RUNNING_WORKSPACES: intFrom(3),
  MAX_TOTAL_WORKSPACES: intFrom(5),

  POSTGRES_ENABLED: flag('true'),
  POSTGRES_HOSTNAME: z.string().default('localhost'),
  POSTGRES_PORT: intFrom(5432),
  POSTGRES_DATABASE: z.string().default(''),
  POSTGRES_USER: z.string().default(''),
  POSTGRES_PASSWORD: z.string().default(''),
  // The existing database requires TLS with a CA file chosen by NODE_ENV (see infra/db/pg-ssl.ts).
  POSTGRES_SSL: flag('true'),
  POSTGRES_CA_FILE: z.string().optional(),
  POSTGRES_CERT_DIR: z.string().optional(),
  POSTGRES_DATABASE_TABLENAME: z.string().default('metrics."devspaces-metrics"'),

  NOTIFICATION_MAIL_URL: z.string().optional(),
  NOTIFICATION_EMAIL_USERNAME: z.string().default(''),
  NOTIFICATION_EMAIL_PASSWORD: z.string().default(''),
  NOTIFICATION_SENDER: z.string().default('noreply@example.com'),
  NOTIFICATION_CC: z.string().optional(),
  EMAIL_DOMAIN: z.string().default('example.com'),
  USER_DIRECTORY_GRAPHQL_URL: z.string().optional(),

  GITHUB_URL: z.string().default('https://github.com'),
  GITHUB_USER_SUFFIX: z.string().default(''),
});

/** `'1524'` → `1524`, `"a b"` → `a b`; anything not wrapped in one matching pair of quotes is untouched. */
export function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/s.exec(value);
  return match?.[2] ?? value;
}

/** `che-code` → `che-incubator/che-code/latest`; `che-incubator/che-code/latest` is kept as it is. */
export function normalizeEditorId(value: string): string {
  const v = value.trim();
  return v.includes('/') ? v : `che-incubator/${v}/latest`;
}

/** `https://api.namctigtd001d.ecs.dyn.example.net:6443` → `namctigtd001d`. */
export function clusterNameOf(apiUrl: string): string | undefined {
  try {
    const host = new URL(apiUrl).hostname;
    return host.startsWith('api.') ? host.split('.')[1] : undefined;
  } catch {
    return undefined;
  }
}

/** `https://api.<rest>:6443` → `https://devspaces.apps.<rest>` (the usual Dev Spaces dashboard host). */
export function deriveDevSpacesFqdn(apiUrl: string): string {
  try {
    const host = new URL(apiUrl).hostname;
    return host.startsWith('api.') ? `https://devspaces.apps.${host.slice('api.'.length)}` : '';
  } catch {
    return '';
  }
}

export interface FoundToken {
  /** The environment variable the token came from (never the token itself). */
  name: string;
  value: string;
}

/**
 * Finds the bearer token for a cluster by variable name: `<prefix><id>`, e.g. devSpacesClusterToken001d for the cluster
 * `namctigtd001d` (the id must be the end of the cluster name). A variable without an id (`<prefix>`) fits any cluster.
 * Tokens that belong to another cluster are ignored, so a leftover `devOpsToken004d` is never sent to cluster 001d.
 */
export function findClusterToken(
  env: Record<string, string | undefined>,
  prefix: string,
  apiUrl: string,
): FoundToken | undefined {
  const cluster = (clusterNameOf(apiUrl) ?? '').toLowerCase();
  const fits = Object.keys(env)
    .filter((k) => k.toLowerCase().startsWith(prefix.toLowerCase()) && env[k])
    .filter((k) => {
      const id = k.slice(prefix.length).toLowerCase();
      return id === '' || (cluster !== '' && cluster.endsWith(id));
    });
  if (fits.length > 1) {
    throw new Error(
      `Invalid configuration:\n  - several variables fit one cluster token: ${fits.join(', ')}`,
    );
  }
  const name = fits[0];
  return name ? { name, value: env[name] as string } : undefined;
}

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Serve the pre-versioning paths (/login, /:soeid/...) as deprecated aliases of /api/v1. */
  legacyRoutes: boolean;
  auth: { secretKey: string; adminUsername: string; adminPassword: string; expiresIn: string };
  cluster: {
    /** The Dev Spaces cluster. */
    apiUrl: string;
    /** Bearer token for it; when unset the kubeconfig / in-cluster service account is used. */
    token?: string;
    /** Name of the variable the token came from, for the startup log (never the token). */
    tokenVar?: string;
    /** Cluster for build/deploy projects: DEPLOY_CLUSTER_API_URL, or the same cluster as apiUrl. */
    deployApiUrl: string;
    /** Only set when the deploy cluster is a different one. */
    deployToken?: string;
    deployTokenVar?: string;
    /** False when NODE_TLS_REJECT_UNAUTHORIZED=0: certificates of the clusters are then not verified. */
    tlsRejectUnauthorized: boolean;
    kubeconfigPath?: string;
    deployProjectRequester: string;
    devSpacesServiceFqdn: string;
  };
  devreg: {
    url: string;
    editors: { vscode: string; intellij: string; goland: string };
    workspaceProxyUrl?: string;
  };
  limits: { maxRunning: number; maxTotal: number };
  postgres: {
    enabled: boolean;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
    /** Explicit CA bundle; when unset the file is chosen from NODE_ENV (dev.pem / uat.pem / prod.pem). */
    caFile?: string;
    certDir?: string;
    /** NODE_ENV, which selects the CA file and whether the hostname check is relaxed (development only). */
    env: string;
    /** Existing metrics table, e.g. metrics."devspaces-metrics-dev". The service only ever inserts into it. */
    table: string;
  };
  notification: {
    url?: string;
    username: string;
    password: string;
    sender: string;
    cc?: string;
    emailDomain: string;
    userDirectoryUrl?: string;
  };
  github: { url: string; userSuffix: string };
}

/** What the service understood from its environment, for the startup log. Contains no secret values. */
export function startupSummary(c: AppConfig): Record<string, unknown> {
  const auth = (tokenVar: string | undefined, kubeconfig: string | undefined): string =>
    tokenVar
      ? `bearer token from ${tokenVar}`
      : kubeconfig
        ? 'kubeconfig file'
        : 'default kubeconfig / pod service account';
  return {
    port: c.port,
    nodeEnv: c.nodeEnv,
    cluster: c.cluster.apiUrl,
    clusterAuth: auth(c.cluster.tokenVar, c.cluster.kubeconfigPath),
    deployCluster: c.cluster.deployApiUrl,
    deployClusterAuth:
      c.cluster.deployApiUrl === c.cluster.apiUrl
        ? 'same cluster'
        : auth(c.cluster.deployTokenVar, c.cluster.kubeconfigPath),
    devSpacesFqdn: c.cluster.devSpacesServiceFqdn,
    devfileRegistry: c.devreg.url,
    editors: c.devreg.editors,
    clusterTls: c.cluster.tlsRejectUnauthorized
      ? 'certificates verified'
      : 'NOT verified (NODE_TLS_REJECT_UNAUTHORIZED=0)',
    postgres: c.postgres.enabled
      ? {
          host: c.postgres.host,
          port: c.postgres.port,
          database: c.postgres.database,
          table: c.postgres.table,
        }
      : 'disabled',
  };
}

/** Parse and validate the environment once, at startup. Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An exported-but-empty variable (`FOO=`) is treated as unset. Values that still carry their shell quotes
  // (`'1524'`, `'metrics."devspaces-metrics-dev"'` from a .env file or a pasted export line) are unwrapped.
  const cleaned = Object.fromEntries(
    Object.entries(env)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, unquote(v as string)]),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const e = parsed.data;
  if (e.POSTGRES_ENABLED && (!e.POSTGRES_DATABASE || !e.POSTGRES_USER)) {
    throw new Error(
      'Invalid configuration:\n  - POSTGRES_DATABASE and POSTGRES_USER are required when POSTGRES_ENABLED=true',
    );
  }

  const deployApiUrl = e.DEPLOY_CLUSTER_API_URL ?? e.CLUSTER_API_URL;
  const separateDeployCluster = deployApiUrl !== e.CLUSTER_API_URL;
  const main = e.CLUSTER_TOKEN
    ? { name: 'CLUSTER_TOKEN', value: e.CLUSTER_TOKEN }
    : findClusterToken(cleaned, 'devSpacesClusterToken', e.CLUSTER_API_URL);
  const deploy = !separateDeployCluster
    ? undefined
    : e.DEPLOY_CLUSTER_TOKEN
      ? { name: 'DEPLOY_CLUSTER_TOKEN', value: e.DEPLOY_CLUSTER_TOKEN }
      : findClusterToken(cleaned, 'devOpsToken', deployApiUrl);
  if (separateDeployCluster && !deploy && !e.KUBECONFIG_PATH) {
    throw new Error(
      `Invalid configuration:\n  - DEPLOY_CLUSTER_API_URL is set to a different cluster but no token was found for it ` +
        `(set DEPLOY_CLUSTER_TOKEN, or devOpsToken<id> where <id> ends the cluster name)`,
    );
  }

  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    legacyRoutes: e.LEGACY_UNVERSIONED_ROUTES,
    auth: {
      secretKey: e.SECRET_KEY,
      adminUsername: e.ADMIN_USERNAME,
      adminPassword: e.ADMIN_PASSWORD,
      expiresIn: e.JWT_EXPIRES_IN,
    },
    cluster: {
      apiUrl: e.CLUSTER_API_URL,
      token: main?.value,
      tokenVar: main?.name,
      deployApiUrl,
      deployToken: deploy?.value,
      deployTokenVar: deploy?.name,
      tlsRejectUnauthorized: cleaned.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
      kubeconfigPath: e.KUBECONFIG_PATH,
      deployProjectRequester: e.DEPLOY_PROJECT_REQUESTER,
      devSpacesServiceFqdn: e.DEV_SPACES_SERVICE_FQDN ?? deriveDevSpacesFqdn(e.CLUSTER_API_URL),
    },
    devreg: {
      url: e.DEVREG_URL,
      editors: {
        vscode: normalizeEditorId(e.EDITOR_VSCODE),
        intellij: normalizeEditorId(e.EDITOR_INTELLIJ),
        goland: normalizeEditorId(e.EDITOR_GOLAND),
      },
      workspaceProxyUrl: e.WORKSPACE_PROXY_URL,
    },
    limits: { maxRunning: e.MAX_RUNNING_WORKSPACES, maxTotal: e.MAX_TOTAL_WORKSPACES },
    postgres: {
      enabled: e.POSTGRES_ENABLED,
      host: e.POSTGRES_HOSTNAME,
      port: e.POSTGRES_PORT,
      database: e.POSTGRES_DATABASE,
      user: e.POSTGRES_USER,
      password: e.POSTGRES_PASSWORD,
      ssl: e.POSTGRES_SSL,
      caFile: e.POSTGRES_CA_FILE,
      certDir: e.POSTGRES_CERT_DIR,
      env: e.NODE_ENV,
      table: e.POSTGRES_DATABASE_TABLENAME,
    },
    notification: {
      url: e.NOTIFICATION_MAIL_URL,
      username: e.NOTIFICATION_EMAIL_USERNAME,
      password: e.NOTIFICATION_EMAIL_PASSWORD,
      sender: e.NOTIFICATION_SENDER,
      cc: e.NOTIFICATION_CC,
      emailDomain: e.EMAIL_DOMAIN,
      userDirectoryUrl: e.USER_DIRECTORY_GRAPHQL_URL,
    },
    github: { url: e.GITHUB_URL.replace(/\/$/, ''), userSuffix: e.GITHUB_USER_SUFFIX },
  };
}
