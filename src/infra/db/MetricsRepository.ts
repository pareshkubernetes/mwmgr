import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { AppConfig } from '../../config/env.js';
import type { MetricsRecord } from '../../domain/types.js';
import type { MetricsStore } from '../ports.js';

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

export function createPgPool(config: AppConfig['postgres']): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true, ca: readFileSync(config.caFile ?? '', 'utf8') } : false,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5000,
  });
}

export class MetricsRepository implements MetricsStore {
  private readonly table: string;

  constructor(
    private readonly db: Queryable,
    table = 'metrics."devspaces-metrics"',
  ) {
    this.table = assertSafeTableName(table);
  }

  async insert(r: MetricsRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table}
        ("timestamp", csiid, soeid, eventtype, resourcename, resourcetype, status,
         limitcpu, limitmemory, requestcpu, requestmemory, duration, storage,
         useraction, workspaceversion, editorname)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        r.timestamp,
        r.csiid,
        r.soeid,
        r.eventtype,
        r.resourcename,
        r.resourcetype,
        JSON.stringify(r.status),
        r.limitcpu,
        r.limitmemory,
        r.requestcpu,
        r.requestmemory,
        r.duration,
        r.storage,
        r.useraction,
        r.workspaceversion,
        r.editorname,
      ],
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
