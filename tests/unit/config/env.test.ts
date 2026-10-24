import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';

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
    expect(ok.postgres).toMatchObject({ enabled: true, database: 'd', user: 'u', port: 5432, ssl: false });
  });

  it('requires a CA file when Postgres SSL is on', () => {
    const env = {
      ...base,
      POSTGRES_ENABLED: 'true',
      POSTGRES_DATABASE: 'd',
      POSTGRES_USER: 'u',
      POSTGRES_SSL: 'true',
    };
    expect(() => loadConfig(env)).toThrow(/POSTGRES_CA_FILE/);
    expect(loadConfig({ ...env, POSTGRES_CA_FILE: '/ca.pem' }).postgres.caFile).toBe('/ca.pem');
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
