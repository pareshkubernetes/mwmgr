import { describe, expect, it, vi } from 'vitest';
import type { MetricsRecord } from '../../../src/domain/types.js';
import {
  MetricsRepository,
  NoopMetricsStore,
  assertSafeTableName,
  createPgPool,
} from '../../../src/infra/db/MetricsRepository.js';

const record: MetricsRecord = {
  timestamp: new Date('2026-01-01T00:00:00Z'),
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

describe('MetricsRepository', () => {
  it('inserts with a parameterised statement, never interpolating values', async () => {
    const query = vi.fn().mockResolvedValue({});
    await new MetricsRepository({ query, end: vi.fn() }).insert({
      ...record,
      resourcename: "x'); DROP TABLE y;--",
    });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO metrics."devspaces-metrics"');
    expect(sql).not.toContain('DROP TABLE');
    expect(values).toHaveLength(16);
    expect(values[4]).toBe("x'); DROP TABLE y;--");
    expect(values[6]).toBe('{"failed":false,"error":"","message":""}');
  });

  it('propagates database errors to the caller (the recorder decides what to do)', async () => {
    const repo = new MetricsRepository({ query: vi.fn().mockRejectedValue(new Error('down')), end: vi.fn() });
    await expect(repo.insert(record)).rejects.toThrow('down');
  });

  it('pings and closes', async () => {
    const query = vi.fn().mockResolvedValue({});
    const end = vi.fn().mockResolvedValue(undefined);
    const repo = new MetricsRepository({ query, end });
    await repo.ping();
    await repo.close();
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(end).toHaveBeenCalled();
  });
});

describe('assertSafeTableName', () => {
  it.each(['metrics."devspaces-metrics"', 'devspaces_metrics', '"a-b"."c-d"', 'public.t'])(
    'accepts %s',
    (name) => {
      expect(assertSafeTableName(name)).toBe(name);
    },
  );
  it.each(['t; DROP TABLE x', 'a b', '', 'a.b.c', 'a"b', "t'--"])('rejects %j', (name) => {
    expect(() => assertSafeTableName(name)).toThrow(/Unsafe/);
  });
  it('is enforced by the constructor', () => {
    expect(() => new MetricsRepository({ query: vi.fn(), end: vi.fn() }, 'x; drop')).toThrow();
  });
});

describe('createPgPool', () => {
  const base = {
    enabled: true,
    host: 'h',
    port: 5432,
    database: 'd',
    user: 'u',
    password: 'p',
    ssl: false,
    table: 't',
  };
  it('builds a pool without SSL', async () => {
    const pool = createPgPool(base);
    expect((pool.options as { ssl?: unknown }).ssl).toBe(false);
    expect(pool.options.max).toBe(5);
    await pool.end();
  });
  it('fails fast when the CA file is unreadable', () => {
    expect(() => createPgPool({ ...base, ssl: true, caFile: '/definitely/not/here.pem' })).toThrow();
  });
});

describe('NoopMetricsStore', () => {
  it('accepts everything', async () => {
    const s = new NoopMetricsStore();
    await expect(Promise.all([s.insert(), s.ping(), s.close()])).resolves.toBeDefined();
  });
});
