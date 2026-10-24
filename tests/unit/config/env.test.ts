import { describe, expect, it } from 'vitest';
import {
  clusterNameOf,
  deriveDevSpacesFqdn,
  findClusterToken,
  loadConfig,
  normalizeEditorId,
  startupSummary,
  unquote,
} from '../../../src/config/env.js';

/** The variables the team really exports (secret values replaced by fakes; quotes as they appear in the notes file). */
const TEAM_ENV = {
  POSTGRES_DATABASE: 'orion_dev_metadata',
  POSTGRES_HOSTNAME: 'NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net',
  POSTGRES_PASSWORD: 'fake-db-password',
  POSTGRES_PORT: "'1524'",
  POSTGRES_USER: 'app_orion_pgsql_dev',
  POSTGRES_DATABASE_TABLENAME: `'metrics."devspaces-metrics-dev"'`,
  NODE_ENV: 'development',
  devOpsToken004d: 'fake-devops-token-004d',
  devSpacesClusterToken001d: 'fake-devspaces-token-001d',
  CLUSTER_API_URL: 'https://api.namctigtd001d.ecs.dyn.nsroot.net:6443',
  DEVREG_URL: 'https://devreg-service-cti-svcs-devfile-registry-177398.apps.namctigtd001d.ecs.dyn.nsroot.net',
  PORT: '8080',
  EDITOR_VSCODE: 'che-incubator/che-code/latest',
  EDITOR_INTELLIJ: 'che-incubator/che-idea-server/latest',
  SECRET_KEY: 'fake-secret-key-0123456789abcdef',
  ADMIN_USERNAME: 'orion-devspaces',
  ADMIN_PASSWORD: 'fake-admin-password',
  NODE_TLS_REJECT_UNAUTHORIZED: "'0'",
};

const base = {
  SECRET_KEY: 'a-sufficiently-long-secret',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'pw',
  DEVREG_URL: 'http://registry',
  POSTGRES_ENABLED: 'false',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3050);
    expect(c.limits).toEqual({ maxRunning: 3, maxTotal: 5 });
    expect(c.devreg.editors).toEqual({
      vscode: 'che-incubator/che-code/latest',
      intellij: 'che-incubator/che-idea/latest',
      goland: 'che-incubator/che-goland/latest',
    });
    expect(c.auth.expiresIn).toBe('60d');
    expect(c.postgres.enabled).toBe(false);
    expect(c.github).toEqual({ url: 'https://github.com', userSuffix: '' });
  });

  it('refuses to start without SECRET_KEY (no fallback secret)', () => {
    const { SECRET_KEY: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/SECRET_KEY/);
  });

  it('rejects a short SECRET_KEY', () => {
    expect(() => loadConfig({ ...base, SECRET_KEY: 'short' })).toThrow(/at least 16/);
  });

  it('lists every problem at once', () => {
    expect(() => loadConfig({})).toThrow(
      /SECRET_KEY[\s\S]*ADMIN_USERNAME[\s\S]*ADMIN_PASSWORD[\s\S]*DEVREG_URL/,
    );
  });

  it('treats empty variables as unset', () => {
    expect(loadConfig({ ...base, PORT: '', KUBECONFIG_PATH: '' }).port).toBe(3050);
    expect(loadConfig({ ...base, KUBECONFIG_PATH: '' }).cluster.kubeconfigPath).toBeUndefined();
  });

  it('coerces numbers and rejects non-positive ones', () => {
    expect(loadConfig({ ...base, PORT: '8080', MAX_RUNNING_WORKSPACES: '7' }).limits.maxRunning).toBe(7);
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('requires database coordinates only when Postgres is enabled', () => {
    expect(() => loadConfig({ ...base, POSTGRES_ENABLED: 'true' })).toThrow(
      /POSTGRES_DATABASE and POSTGRES_USER/,
    );
    const ok = loadConfig({ ...base, POSTGRES_ENABLED: 'true', POSTGRES_DATABASE: 'd', POSTGRES_USER: 'u' });
    expect(ok.postgres).toMatchObject({ enabled: true, database: 'd', user: 'u', port: 5432, ssl: true });
  });

  it('uses TLS to Postgres by default, as the original service always did', () => {
    const env = { ...base, POSTGRES_ENABLED: 'true', POSTGRES_DATABASE: 'd', POSTGRES_USER: 'u' };
    expect(loadConfig(env).postgres).toMatchObject({ ssl: true, env: 'development', caFile: undefined });
    expect(loadConfig({ ...env, POSTGRES_SSL: 'false' }).postgres.ssl).toBe(false);
    expect(loadConfig({ ...env, NODE_ENV: 'production' }).postgres.env).toBe('production');
  });

  it('accepts explicit CA overrides', () => {
    const env = { ...base, POSTGRES_ENABLED: 'true', POSTGRES_DATABASE: 'd', POSTGRES_USER: 'u' };
    const pg = loadConfig({ ...env, POSTGRES_CA_FILE: '/ca.pem', POSTGRES_CERT_DIR: '/certs' }).postgres;
    expect(pg).toMatchObject({ caFile: '/ca.pem', certDir: '/certs' });
  });

  describe('the existing Orion database environment', () => {
    // Exactly what the team exports (quotes included, as they appear when pasted from the notes file).
    const exported = {
      POSTGRES_DATABASE: 'orion_dev_metadata',
      POSTGRES_HOSTNAME: 'NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net',
      POSTGRES_PASSWORD: 'secret',
      POSTGRES_PORT: "'1524'",
      POSTGRES_USER: 'app_orion_pgsql_dev',
      POSTGRES_DATABASE_TABLENAME: `'metrics."devspaces-metrics-dev"'`,
      NODE_ENV: 'development',
    };

    it('is understood as-is, with or without the shell quotes', () => {
      for (const env of [
        exported,
        {
          ...exported,
          POSTGRES_PORT: '1524',
          POSTGRES_DATABASE_TABLENAME: 'metrics."devspaces-metrics-dev"',
        },
      ]) {
        expect(loadConfig({ ...base, POSTGRES_ENABLED: 'true', ...env }).postgres).toEqual({
          enabled: true,
          host: 'NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net',
          port: 1524,
          database: 'orion_dev_metadata',
          user: 'app_orion_pgsql_dev',
          password: 'secret',
          ssl: true,
          caFile: undefined,
          certDir: undefined,
          env: 'development',
          table: 'metrics."devspaces-metrics-dev"',
        });
      }
    });

    it('defaults to Postgres being on, so these variables alone are enough', () => {
      const { POSTGRES_ENABLED: _off, ...withoutFlag } = base;
      expect(loadConfig({ ...withoutFlag, ...exported }).postgres.enabled).toBe(true);
    });
  });

  it('unquote only unwraps one matching pair', () => {
    expect(unquote("'a'")).toBe('a');
    expect(unquote('"a b"')).toBe('a b');
    expect(unquote(`'metrics."t-1"'`)).toBe('metrics."t-1"');
    for (const untouched of ["'a", 'a"', `'a"`, 'plain', "it's", '"', "''".slice(0, 1)]) {
      expect(unquote(untouched)).toBe(untouched);
    }
    expect(unquote("''")).toBe('');
  });

  it('strips a trailing slash from GITHUB_URL', () => {
    expect(loadConfig({ ...base, GITHUB_URL: 'https://ghe.example.com/' }).github.url).toBe(
      'https://ghe.example.com',
    );
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});

describe("the team's real environment (every variable they export)", () => {
  const c = () => loadConfig(TEAM_ENV);

  it('is accepted as it is, and nothing is left unused', () => {
    const cfg = c();
    expect(cfg.port).toBe(8080);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.auth).toMatchObject({ adminUsername: 'orion-devspaces', secretKey: TEAM_ENV.SECRET_KEY });
    expect(cfg.devreg.url).toBe(TEAM_ENV.DEVREG_URL);
    expect(cfg.postgres).toMatchObject({
      host: 'NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net',
      port: 1524,
      database: 'orion_dev_metadata',
      user: 'app_orion_pgsql_dev',
      table: 'metrics."devspaces-metrics-dev"',
    });
  });

  it('authenticates to the Dev Spaces cluster with devSpacesClusterToken001d', () => {
    const { cluster } = c();
    expect(cluster.apiUrl).toBe('https://api.namctigtd001d.ecs.dyn.nsroot.net:6443');
    expect(cluster.token).toBe('fake-devspaces-token-001d');
    expect(cluster.tokenVar).toBe('devSpacesClusterToken001d');
  });

  it('does not send devOpsToken004d to cluster 001d: that token belongs to cluster 004d', () => {
    const { cluster } = c();
    expect(cluster.deployApiUrl).toBe(cluster.apiUrl); // DEPLOY_CLUSTER_API_URL is commented out
    expect(cluster.deployToken).toBeUndefined();
    expect(JSON.stringify(cluster)).not.toContain('fake-devops-token-004d');
  });

  it('uses devOpsToken004d for a separate deploy cluster 004d, and the right token for each', () => {
    const { cluster } = loadConfig({
      ...TEAM_ENV,
      DEPLOY_CLUSTER_API_URL: 'https://api.namctiswd004d.ecs.dyn.nsroot.net:6443',
    });
    expect(cluster.apiUrl).toContain('namctigtd001d');
    expect(cluster.token).toBe('fake-devspaces-token-001d');
    expect(cluster.deployApiUrl).toBe('https://api.namctiswd004d.ecs.dyn.nsroot.net:6443');
    expect(cluster.deployToken).toBe('fake-devops-token-004d');
    expect(cluster.deployTokenVar).toBe('devOpsToken004d');
  });

  it('uses the full editor ids exactly as exported (no double che-incubator/…/latest)', () => {
    expect(c().devreg.editors).toMatchObject({
      vscode: 'che-incubator/che-code/latest',
      intellij: 'che-incubator/che-idea-server/latest',
    });
  });

  it('survives the stray empty EDITOR_INTELLIJ="" line the notes file also contains', () => {
    // in a shell the later assignment wins; an empty value must never override a real one or break the default
    expect(loadConfig({ ...TEAM_ENV, EDITOR_INTELLIJ: '' }).devreg.editors.intellij).toBe(
      'che-incubator/che-idea/latest',
    );
  });

  it("honours NODE_TLS_REJECT_UNAUTHORIZED='0' for the clusters, and verifies by default", () => {
    expect(c().cluster.tlsRejectUnauthorized).toBe(false);
    const { NODE_TLS_REJECT_UNAUTHORIZED: _off, ...verified } = TEAM_ENV;
    expect(loadConfig(verified).cluster.tlsRejectUnauthorized).toBe(true);
    expect(loadConfig({ ...verified, NODE_TLS_REJECT_UNAUTHORIZED: '1' }).cluster.tlsRejectUnauthorized).toBe(
      true,
    );
  });

  it('works out the Dev Spaces dashboard address from the cluster URL when it is not set', () => {
    expect(c().cluster.devSpacesServiceFqdn).toBe('https://devspaces.apps.namctigtd001d.ecs.dyn.nsroot.net');
    expect(
      loadConfig({ ...TEAM_ENV, DEV_SPACES_SERVICE_FQDN: 'https://ds.example' }).cluster.devSpacesServiceFqdn,
    ).toBe('https://ds.example');
  });

  it('the startup summary names what was understood but contains no secret value', () => {
    const summary = JSON.stringify(startupSummary(c()));
    expect(summary).toContain('bearer token from devSpacesClusterToken001d');
    expect(summary).toContain('NOT verified');
    expect(summary).toContain('orion_dev_metadata');
    for (const secret of [
      'fake-devspaces-token-001d',
      'fake-devops-token-004d',
      'fake-db-password',
      'fake-admin-password',
      TEAM_ENV.SECRET_KEY,
    ]) {
      expect(summary).not.toContain(secret);
    }
  });
});

describe('cluster tokens', () => {
  const URL001 = 'https://api.namctigtd001d.ecs.dyn.nsroot.net:6443';

  it('explicit CLUSTER_TOKEN / DEPLOY_CLUSTER_TOKEN win over the by-name lookup', () => {
    const { cluster } = loadConfig({
      ...TEAM_ENV,
      CLUSTER_TOKEN: 'explicit-main',
      DEPLOY_CLUSTER_API_URL: 'https://api.namctiswd004d.ecs.dyn.nsroot.net:6443',
      DEPLOY_CLUSTER_TOKEN: 'explicit-deploy',
    });
    expect([cluster.token, cluster.tokenVar]).toEqual(['explicit-main', 'CLUSTER_TOKEN']);
    expect([cluster.deployToken, cluster.deployTokenVar]).toEqual([
      'explicit-deploy',
      'DEPLOY_CLUSTER_TOKEN',
    ]);
  });

  it('refuses a separate deploy cluster for which no token exists', () => {
    const { devOpsToken004d: _no, ...noDevOps } = TEAM_ENV;
    expect(() =>
      loadConfig({
        ...noDevOps,
        DEPLOY_CLUSTER_API_URL: 'https://api.namctiswd004d.ecs.dyn.nsroot.net:6443',
      }),
    ).toThrow(/DEPLOY_CLUSTER_API_URL.*no token/s);
    // with a kubeconfig that is fine: it carries its own credentials
    expect(() =>
      loadConfig({
        ...noDevOps,
        KUBECONFIG_PATH: '/kube/config',
        DEPLOY_CLUSTER_API_URL: 'https://api.namctiswd004d.ecs.dyn.nsroot.net:6443',
      }),
    ).not.toThrow();
  });

  it('runs without any token when none is set (kubeconfig / service account)', () => {
    const { devSpacesClusterToken001d: _a, devOpsToken004d: _b, ...none } = TEAM_ENV;
    const { cluster } = loadConfig(none);
    expect(cluster.token).toBeUndefined();
    expect(startupSummary(loadConfig(none)).clusterAuth).toBe('default kubeconfig / pod service account');
  });

  it('findClusterToken matches the id against the END of the cluster name, case-insensitively', () => {
    const env = { devSpacesClusterToken001D: 'a', devSpacesClusterToken002d: 'b', devOpsToken001d: 'c' };
    expect(findClusterToken(env, 'devSpacesClusterToken', URL001)).toEqual({
      name: 'devSpacesClusterToken001D',
      value: 'a',
    });
    expect(findClusterToken(env, 'devOpsToken', URL001)?.value).toBe('c');
    expect(
      findClusterToken(env, 'devSpacesClusterToken', 'https://api.other999x.example:6443'),
    ).toBeUndefined();
  });

  it('a variable without an id fits any cluster, but two that fit is an error', () => {
    expect(findClusterToken({ devOpsToken: 'x' }, 'devOpsToken', URL001)?.value).toBe('x');
    expect(findClusterToken({ devOpsToken: 'x' }, 'devOpsToken', 'http://localhost')?.value).toBe('x');
    expect(() => findClusterToken({ devOpsToken: 'x', devOpsToken001d: 'y' }, 'devOpsToken', URL001)).toThrow(
      /several/,
    );
  });

  it('ignores empty values and an id that cannot be checked against a name-less cluster URL', () => {
    expect(findClusterToken({ devOpsToken001d: '' }, 'devOpsToken', URL001)).toBeUndefined();
    expect(
      findClusterToken({ devOpsToken001d: 'y' }, 'devOpsToken', 'http://localhost:8001'),
    ).toBeUndefined();
  });
});

describe('logging settings', () => {
  const base = { ...TEAM_ENV };

  it('defaults to the readable coloured format', () => {
    const c = loadConfig(base);
    expect(c.logFormat).toBe('pretty');
    expect(c.logColor).toBe(true);
  });

  it('LOG_FORMAT=json switches to one JSON object per line', () => {
    expect(loadConfig({ ...base, LOG_FORMAT: 'json' }).logFormat).toBe('json');
    expect(() => loadConfig({ ...base, LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT/);
  });

  it('colours can be switched off with LOG_COLOR=false or the standard NO_COLOR variable', () => {
    expect(loadConfig({ ...base, LOG_COLOR: 'false' }).logColor).toBe(false);
    expect(loadConfig({ ...base, NO_COLOR: '1' }).logColor).toBe(false);
    expect(loadConfig({ ...base, NO_COLOR: '' }).logColor).toBe(true);
  });
});

describe('address helpers', () => {
  it('clusterNameOf', () => {
    expect(clusterNameOf('https://api.namctigtd001d.ecs.dyn.nsroot.net:6443')).toBe('namctigtd001d');
    expect(clusterNameOf('https://kubernetes.default.svc')).toBeUndefined();
    expect(clusterNameOf('not a url')).toBeUndefined();
    expect(clusterNameOf('')).toBeUndefined();
  });

  it('deriveDevSpacesFqdn', () => {
    expect(deriveDevSpacesFqdn('https://api.prod1.ecs.example.net:6443')).toBe(
      'https://devspaces.apps.prod1.ecs.example.net',
    );
    expect(deriveDevSpacesFqdn('https://10.0.0.1:6443')).toBe('');
    expect(deriveDevSpacesFqdn('')).toBe('');
  });

  it('normalizeEditorId keeps full ids and expands bare names', () => {
    expect(normalizeEditorId('che-incubator/che-code/latest')).toBe('che-incubator/che-code/latest');
    expect(normalizeEditorId('acme/my-editor/1.2')).toBe('acme/my-editor/1.2');
    expect(normalizeEditorId('che-code')).toBe('che-incubator/che-code/latest');
    expect(normalizeEditorId(' che-idea ')).toBe('che-incubator/che-idea/latest');
  });
});
