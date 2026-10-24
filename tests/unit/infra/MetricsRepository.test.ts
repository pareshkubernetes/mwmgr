import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/env.js';
import type { MetricsRecord } from '../../../src/domain/types.js';
import {
  MetricsRepository,
  NoopMetricsStore,
  assertSafeTableName,
  candidateColumns,
  createPgPool,
  formatUtc,
  parseTableName,
} from '../../../src/infra/db/MetricsRepository.js';
import { buildSslOptions, resolveCaPath } from '../../../src/infra/db/pg-ssl.js';
import { createLogger } from '../../../src/utils/logger.js';

type PgConfig = AppConfig['postgres'];

const record: MetricsRecord = {
  timestamp: new Date('2026-01-02T03:04:05.678Z'),
  csiid: '1001',
  soeid: 'pp1',
  eventtype: 'create',
  resourcename: 'ws',
  resourcetype: 'workspace',
  status: { failed: false, error: '', message: '' },
  useraction: 'user',
  limitcpu: 2,
  limitmemory: 4,
  requestcpu: 0.5,
  requestmemory: 1,
  duration: '0 seconds',
  storage: 3,
  workspaceversion: '2.0.0',
  editorname: 'vscode',
};

const ALL = [
  'id',
  'timestamp',
  'csiid',
  'soeid',
  'eventtype',
  'resourcename',
  'resourcetype',
  'status',
  'limitcpu',
  'limitmemory',
  'requestcpu',
  'requestmemory',
  'duration',
  'storage',
  'useraction',
  'workspaceversion',
  'editorname',
  'errordetail',
];

/** The shape the ORIGINAL service wrote (no workspaceversion / editorname). */
const LEGACY = ALL.filter((c) => c !== 'workspaceversion' && c !== 'editorname');

function fakeDb(columns: string[] | Error | 'none') {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql.includes('information_schema.columns')) {
      if (columns instanceof Error) throw columns;
      return { rows: columns === 'none' ? [] : columns.map((c) => ({ column_name: c })) };
    }
    return {};
  });
  const insertQuery = () => queries.find((q) => q.sql.startsWith('INSERT'));
  return { db: { query, end: vi.fn().mockResolvedValue(undefined) }, queries, insertQuery };
}

function logs() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: createLogger('debug', (l) => lines.push(JSON.parse(l))) };
}

describe('MetricsRepository.insert', () => {
  it('inserts every field into a table that has all columns, fully parameterised', async () => {
    const { db, insertQuery } = fakeDb(ALL);
    await new MetricsRepository(db).insert({ ...record, resourcename: "x'); DROP TABLE y;--" });
    const q = insertQuery();
    expect(q?.sql).toMatch(/^INSERT INTO metrics\."devspaces-metrics" \("timestamp", "csiid"/);
    expect(q?.sql).not.toContain('DROP TABLE');
    expect(q?.values).toHaveLength(17);
    expect(q?.values).toContain("x'); DROP TABLE y;--");
  });

  it('writes the timestamp as UTC wall-clock text, like the original service', async () => {
    const { db, insertQuery } = fakeDb(ALL);
    await new MetricsRepository(db).insert(record);
    expect(insertQuery()?.values?.[0]).toBe('2026-01-02 03:04:05.678');
    expect(formatUtc(record.timestamp)).toBe('2026-01-02 03:04:05.678');
  });

  it('adapts to a table that predates some columns (legacy shape: no workspaceversion/editorname)', async () => {
    const { db, insertQuery } = fakeDb(LEGACY);
    const { lines, logger } = logs();
    const repo = new MetricsRepository(db, 'metrics."devspaces-metrics-dev"', logger);
    await repo.insert(record);
    await repo.insert(record);
    const sql = insertQuery()?.sql ?? '';
    expect(sql).toContain('INSERT INTO metrics."devspaces-metrics-dev"');
    expect(sql).not.toContain('workspaceversion');
    expect(sql).not.toContain('editorname');
    expect(sql).toContain('"errordetail"');
    // told once, not on every insert
    expect(lines.filter((l) => l.event === 'metrics.columns_missing')).toHaveLength(1);
    expect(lines.find((l) => l.event === 'metrics.columns_missing')?.missing).toBe(
      'workspaceversion,editorname',
    );
  });

  it('looks the columns up once per process, not per insert', async () => {
    const { db, queries } = fakeDb(ALL);
    const repo = new MetricsRepository(db);
    await repo.insert(record);
    await repo.insert(record);
    await repo.insert(record);
    expect(queries.filter((q) => q.sql.includes('information_schema'))).toHaveLength(1);
    expect(queries.filter((q) => q.sql.startsWith('INSERT'))).toHaveLength(3);
  });

  it('matches the table by schema and unquoted name', async () => {
    const { db, queries } = fakeDb(ALL);
    await new MetricsRepository(db, 'metrics."devspaces-metrics-dev"').insert(record);
    expect(queries[0]?.values).toEqual(['devspaces-metrics-dev', 'metrics']);
  });

  it('stores the error text in errordetail only for failures', async () => {
    expect(candidateColumns(record).errordetail).toBeNull();
    const failed = { ...record, status: { failed: true, error: 'quota exceeded', message: '' } };
    expect(candidateColumns(failed).errordetail).toBe('quota exceeded');
    expect(candidateColumns(failed).status).toBe('{"failed":true,"error":"quota exceeded","message":""}');
  });

  it('falls back to all fields (and warns) when the column list cannot be read, then retries discovery', async () => {
    const { db, queries } = fakeDb(new Error('permission denied for information_schema'));
    const { lines, logger } = logs();
    const repo = new MetricsRepository(db, undefined, logger);
    await repo.insert(record);
    await repo.insert(record);
    expect(lines.filter((l) => l.event === 'metrics.columns_discovery_failed')).toHaveLength(2);
    expect(queries.filter((q) => q.sql.includes('information_schema'))).toHaveLength(2);
    expect(queries.filter((q) => q.sql.startsWith('INSERT'))[0]?.values).toHaveLength(17);
  });

  it('falls back to all fields (and warns) when the table is not visible at all', async () => {
    const { db, insertQuery } = fakeDb('none');
    const { lines, logger } = logs();
    await new MetricsRepository(db, undefined, logger).insert(record);
    expect(insertQuery()?.values).toHaveLength(17);
    expect(lines.some((l) => l.event === 'metrics.columns_unknown')).toBe(true);
  });

  it('fails clearly when the table shares no column with the service', async () => {
    const { db } = fakeDb(['foo', 'bar']);
    await expect(new MetricsRepository(db).insert(record)).rejects.toThrow(
      /none of the expected metrics columns/,
    );
  });

  it('propagates insert errors to the caller (the recorder decides what to do)', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) throw new Error('relation does not exist');
      return { rows: ALL.map((c) => ({ column_name: c })) };
    });
    await expect(new MetricsRepository({ query, end: vi.fn() }).insert(record)).rejects.toThrow(
      'relation does not exist',
    );
  });

  it('NEVER issues DDL or anything but INSERT and SELECT', async () => {
    for (const columns of [ALL, LEGACY, new Error('x'), 'none' as const]) {
      const { db, queries } = fakeDb(columns);
      const repo = new MetricsRepository(db, 'metrics."devspaces-metrics-dev"');
      await repo.insert(record);
      await repo.ping();
      for (const { sql } of queries) {
        expect(sql.trim()).toMatch(/^(INSERT|SELECT)\b/i);
        expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE|GRANT)\b/i);
      }
    }
  });

  it('pings and closes', async () => {
    const { db } = fakeDb(ALL);
    const repo = new MetricsRepository(db);
    await repo.ping();
    await repo.close();
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
    expect(db.end).toHaveBeenCalled();
  });
});

describe('table names', () => {
  it.each([
    'metrics."devspaces-metrics"',
    'metrics."devspaces-metrics-dev"',
    'devspaces_metrics',
    '"a-b"."c-d"',
    'public.t',
  ])('accepts %s', (name) => expect(assertSafeTableName(name)).toBe(name));
  it.each(['t; DROP TABLE x', 'a b', '', 'a.b.c', 'a"b', "t'--"])('rejects %j', (name) => {
    expect(() => assertSafeTableName(name)).toThrow(/Unsafe/);
  });
  it('is enforced by the constructor', () => {
    expect(() => new MetricsRepository({ query: vi.fn(), end: vi.fn() }, 'x; drop')).toThrow();
  });
  it('parseTableName', () => {
    expect(parseTableName('metrics."devspaces-metrics-dev"')).toEqual({
      schema: 'metrics',
      name: 'devspaces-metrics-dev',
    });
    expect(parseTableName('plain_table')).toEqual({ name: 'plain_table' });
    expect(parseTableName('"a-b"."c-d"')).toEqual({ schema: 'a-b', name: 'c-d' });
  });
});

const pgConfig = (over: Partial<PgConfig> = {}): PgConfig => ({
  enabled: true,
  host: 'NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net',
  port: 1524,
  database: 'orion_dev_metadata',
  user: 'app_orion_pgsql_dev',
  password: 'pw',
  ssl: true,
  env: 'development',
  table: 'metrics."devspaces-metrics-dev"',
  ...over,
});

describe('TLS to the existing database (same rules as the original service)', () => {
  it('picks the CA file from NODE_ENV', () => {
    expect(resolveCaPath(pgConfig({ env: 'development' }), '/work')).toMatch(
      /[\\/]work[\\/]certs[\\/]dev\.pem$/,
    );
    expect(resolveCaPath(pgConfig({ env: 'uat' }))).toMatch(/[\\/]app[\\/]backend[\\/]cert[\\/]uat\.pem$/);
    expect(resolveCaPath(pgConfig({ env: 'production' }))).toMatch(
      /[\\/]app[\\/]backend[\\/]cert[\\/]prod\.pem$/,
    );
  });

  it('falls back to dev.pem for an unknown NODE_ENV, in the container directory', () => {
    expect(resolveCaPath(pgConfig({ env: 'staging' }))).toMatch(
      /[\\/]app[\\/]backend[\\/]cert[\\/]dev\.pem$/,
    );
  });

  it('lets POSTGRES_CERT_DIR and POSTGRES_CA_FILE override the location', () => {
    expect(resolveCaPath(pgConfig({ env: 'uat', certDir: '/mnt/certs' }))).toMatch(
      /[\\/]mnt[\\/]certs[\\/]uat\.pem$/,
    );
    expect(resolveCaPath(pgConfig({ caFile: '/x/custom.pem', certDir: '/ignored' }))).toBe('/x/custom.pem');
  });

  it('development: verifies the certificate but skips the hostname check', () => {
    const ssl = buildSslOptions(pgConfig({ env: 'development' }), () => 'CA-DEV');
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: 'CA-DEV' });
    expect((ssl as { checkServerIdentity?: () => unknown }).checkServerIdentity?.()).toBeUndefined();
  });

  it('uat/production: full verification including the hostname', () => {
    for (const env of ['uat', 'production']) {
      const ssl = buildSslOptions(pgConfig({ env }), () => 'CA');
      expect(ssl).toEqual({ rejectUnauthorized: true, ca: 'CA' });
    }
  });

  it('can be switched off for a local database', () => {
    expect(buildSslOptions(pgConfig({ ssl: false }), () => 'never read')).toBe(false);
  });

  it('names the file and the fix when the CA cannot be read', () => {
    const read = () => {
      throw new Error('ENOENT');
    };
    expect(() => buildSslOptions(pgConfig({ env: 'uat' }), read)).toThrow(
      /uat\.pem.*NODE_ENV=uat.*POSTGRES_CA_FILE/s,
    );
  });
});

describe('createPgPool', () => {
  it('builds a pool from the environment-style settings without connecting', async () => {
    const pool = createPgPool(pgConfig({ ssl: false }));
    expect(pool.options).toMatchObject({
      host: 'NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net',
      port: 1524,
      database: 'orion_dev_metadata',
      user: 'app_orion_pgsql_dev',
      max: 5,
    });
    await pool.end();
  });

  it('survives idle-client errors instead of crashing the process', async () => {
    const { lines, logger } = logs();
    const pool = createPgPool(pgConfig({ ssl: false }), logger);
    expect(() =>
      pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();
    expect(lines[0]).toMatchObject({ event: 'postgres.pool_error' });
    await pool.end();
  });

  it('fails fast when TLS is on but the CA file is missing', () => {
    expect(() => createPgPool(pgConfig({ caFile: '/definitely/not/here.pem' }))).toThrow(/CA certificate/);
  });
});

describe('NoopMetricsStore', () => {
  it('accepts everything', async () => {
    const s = new NoopMetricsStore();
    await expect(Promise.all([s.insert(), s.ping(), s.close()])).resolves.toBeDefined();
  });
});
