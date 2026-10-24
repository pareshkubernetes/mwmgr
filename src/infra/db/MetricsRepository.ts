import pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import type { MetricsRecord } from '../../types.js';
import { errorMessage } from '../../utils/errors.js';
import { silentLogger, type Logger } from '../../utils/logger.js';
import type { MetricsStore } from '../ports.js';
import { buildSslOptions } from './pg-ssl.js';

/** The subset of `pg.Pool` the repository needs (also satisfied by pg-mem's pool in tests). */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

const TABLE_RE = /^("[\w-]+"|[A-Za-z_]\w*)(\.("[\w-]+"|[A-Za-z_]\w*))?$/;

export function assertSafeTableName(table: string): string {
  if (!TABLE_RE.test(table)) throw new Error(`Unsafe metrics table name: ${table}`);
  return table;
}

/** `metrics."devspaces-metrics-dev"` → `{ schema: 'metrics', name: 'devspaces-metrics-dev' }`. */
export function parseTableName(table: string): { schema?: string; name: string } {
  const unq = (s: string): string => s.replace(/^"|"$/g, '');
  const parts = assertSafeTableName(table).match(/"[\w-]+"|[A-Za-z_]\w*/g) ?? [];
  const name = unq(parts[parts.length - 1] ?? '');
  return parts.length > 1 ? { schema: unq(parts[0] ?? ''), name } : { name };
}

export function createPgPool(config: AppConfig['postgres'], logger: Logger = silentLogger): pg.Pool {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: buildSslOptions(config),
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5000,
  });
  // An idle client dropped by the server emits 'error'; unhandled, it would crash the process.
  pool.on('error', (error) => logger.error('postgres.pool_error', { error: errorMessage(error) }));
  return pool;
}

/** Database timestamps use UTC wall-clock text: `2026-01-02 03:04:05.678`. */
export const formatUtc = (date: Date): string => date.toISOString().replace('T', ' ').replace('Z', '');

/** Every value the service can store, keyed by column name. */
export function candidateColumns(r: MetricsRecord): Record<string, unknown> {
  return {
    timestamp: formatUtc(r.timestamp),
    csiid: r.csiid,
    soeid: r.soeid,
    eventtype: r.eventtype,
    resourcename: r.resourcename,
    resourcetype: r.resourcetype,
    status: JSON.stringify(r.status),
    limitcpu: r.limitcpu,
    limitmemory: r.limitmemory,
    requestcpu: r.requestcpu,
    requestmemory: r.requestmemory,
    duration: r.duration,
    storage: r.storage,
    useraction: r.useraction,
    workspaceversion: r.workspaceversion,
    editorname: r.editorname,
    errordetail: r.status.failed ? r.status.error : null,
  };
}

/**
 * Writes metrics rows into an EXISTING table. It never issues DDL (no CREATE/ALTER/DROP): it reads the table's
 * column list once and inserts only the columns that exist, so a table that predates some of our fields still works.
 */
export class MetricsRepository implements MetricsStore {
  private readonly table: string;
  private columns?: Promise<Set<string> | undefined>;
  private warnedMissing = false;

  constructor(
    private readonly db: Queryable,
    table = 'metrics."devspaces-metrics"',
    private readonly logger: Logger = silentLogger,
  ) {
    this.table = assertSafeTableName(table);
  }

  private knownColumns(): Promise<Set<string> | undefined> {
    this.columns ??= this.discoverColumns();
    return this.columns;
  }

  /**
   * Read-only column discovery, two independent ways: the catalog (works with INSERT-only privileges),
   * then an empty SELECT whose result metadata lists the columns (works when the catalog is hidden).
   */
  private async discoverColumns(): Promise<Set<string> | undefined> {
    const errors: string[] = [];

    try {
      const { schema, name } = parseTableName(this.table);
      const result = (await this.db.query(
        schema
          ? 'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2'
          : 'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
        schema ? [schema, name] : [name],
      )) as { rows?: { column_name: string }[] };
      const names = (result.rows ?? []).map((row) => row.column_name.toLowerCase());
      if (names.length > 0) return new Set(names);
    } catch (error) {
      errors.push(`information_schema: ${errorMessage(error)}`);
    }

    try {
      const result = (await this.db.query(`SELECT * FROM ${this.table} LIMIT 0`)) as {
        fields?: { name: string }[];
      };
      const names = (result.fields ?? []).map((field) => field.name.toLowerCase());
      if (names.length > 0) return new Set(names);
    } catch (error) {
      errors.push(`select: ${errorMessage(error)}`);
      // Do not cache a failure: try again on the next insert.
      this.columns = undefined;
    }

    this.logger.warn('metrics.columns_unknown', {
      table: this.table,
      reason: 'could not read the table columns; inserting all fields',
      errors: errors.join(' | '),
    });
    return undefined;
  }

  async insert(record: MetricsRecord): Promise<void> {
    const all = candidateColumns(record);
    const known = await this.knownColumns();
    const names = known ? Object.keys(all).filter((column) => known.has(column)) : Object.keys(all);

    if (known && !this.warnedMissing) {
      const missing = Object.keys(all).filter((column) => !known.has(column));
      if (missing.length > 0) {
        this.warnedMissing = true;
        this.logger.warn('metrics.columns_missing', { table: this.table, missing: missing.join(',') });
      }
    }
    if (names.length === 0) throw new Error(`Table ${this.table} has none of the expected metrics columns`);

    const columns = names.map((column) => `"${column}"`).join(', ');
    const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
    await this.db.query(
      `INSERT INTO ${this.table} (${columns}) VALUES (${placeholders})`,
      names.map((column) => all[column]),
    );
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }

  close(): Promise<void> {
    return this.db.end();
  }
}

/** Used when POSTGRES_ENABLED=false (local runs); drops records. */
export class NoopMetricsStore implements MetricsStore {
  async insert(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
