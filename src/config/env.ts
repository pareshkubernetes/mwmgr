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
  KUBECONFIG_PATH: z.string().optional(),
  DEPLOY_PROJECT_REQUESTER: z.string().default('devspaces-support-team'),
  DEV_SPACES_SERVICE_FQDN: z.string().default(''),

  DEVREG_URL: z.string().min(1, 'DEVREG_URL is required'),
  EDITOR_VSCODE: z.string().default('che-code'),
  EDITOR_INTELLIJ: z.string().default('che-idea'),
  EDITOR_GOLAND: z.string().default('che-goland'),
  WORKSPACE_PROXY_URL: z.string().optional(),

  MAX_RUNNING_WORKSPACES: intFrom(3),
  MAX_TOTAL_WORKSPACES: intFrom(5),

  POSTGRES_ENABLED: flag('true'),
  POSTGRES_HOSTNAME: z.string().default('localhost'),
  POSTGRES_PORT: intFrom(5432),
  POSTGRES_DATABASE: z.string().default(''),
  POSTGRES_USER: z.string().default(''),
  POSTGRES_PASSWORD: z.string().default(''),
  POSTGRES_SSL: flag(),
  POSTGRES_CA_FILE: z.string().optional(),
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

export interface AppConfig {
  port: number;
  nodeEnv: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Serve the pre-versioning paths (/login, /:soeid/...) as deprecated aliases of /api/v1. */
  legacyRoutes: boolean;
  auth: { secretKey: string; adminUsername: string; adminPassword: string; expiresIn: string };
  cluster: {
    apiUrl: string;
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
    caFile?: string;
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

/** Parse and validate the environment once, at startup. Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An exported-but-empty variable (`FOO=`) is treated as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
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
  if (e.POSTGRES_ENABLED && e.POSTGRES_SSL && !e.POSTGRES_CA_FILE) {
    throw new Error('Invalid configuration:\n  - POSTGRES_CA_FILE is required when POSTGRES_SSL=true');
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
      kubeconfigPath: e.KUBECONFIG_PATH,
      deployProjectRequester: e.DEPLOY_PROJECT_REQUESTER,
      devSpacesServiceFqdn: e.DEV_SPACES_SERVICE_FQDN,
    },
    devreg: {
      url: e.DEVREG_URL,
      editors: { vscode: e.EDITOR_VSCODE, intellij: e.EDITOR_INTELLIJ, goland: e.EDITOR_GOLAND },
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
