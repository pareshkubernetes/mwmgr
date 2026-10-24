import { describe, expect, it } from 'vitest';
import { loadConfig, unquote } from '../../../src/config/env.js';

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
    expect(c.devreg.editors).toEqual({ vscode: 'che-code', intellij: 'che-idea', goland: 'che-goland' });
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
