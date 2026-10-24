import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { buildContainer, type Container, type Dependencies } from '../../src/container.js';
import { createApp } from '../../src/http/app.js';
import { MetricsRepository } from '../../src/infra/db/MetricsRepository.js';
import { silentLogger } from '../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore, FakeNotifier, FakeRegistry } from './fakes.js';
import { InMemoryKube } from './InMemoryKube.js';

export const TEST_SECRET = 'test-secret-key-0123456789abcdef';
export const ADMIN = { username: 'orion-admin', password: 'correct horse battery staple' };

export function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    SECRET_KEY: TEST_SECRET,
    ADMIN_USERNAME: ADMIN.username,
    ADMIN_PASSWORD: ADMIN.password,
    DEVREG_URL: 'http://registry.test',
    CLUSTER_API_URL: 'https://api.testcluster.ecs.dyn.example.net:6443',
    DEV_SPACES_SERVICE_FQDN: 'https://devspaces.test',
    POSTGRES_ENABLED: 'false',
    MAX_RUNNING_WORKSPACES: '2',
    MAX_TOTAL_WORKSPACES: '3',
    EMAIL_DOMAIN: 'example.com',
    ...overrides,
  });
}

/** A throwaway kubeconfig pointing at nothing; enough to construct the real KubeClient. */
export function writeTestKubeconfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wsm-kube-'));
  const file = join(dir, 'config');
  writeFileSync(
    file,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '  - name: test',
      '    cluster: { server: "https://127.0.0.1:1", insecure-skip-tls-verify: true }',
      'users:',
      '  - name: test',
      '    user: { token: test-token }',
      'contexts:',
      '  - name: test',
      '    context: { cluster: test, user: test }',
      'current-context: test',
      '',
    ].join('\n'),
  );
  return file;
}

export interface Fakes {
  kube: InMemoryKube;
  metrics: FakeMetricsStore;
  notifier: FakeNotifier;
  registry: FakeRegistry;
  clock: FakeClock;
}

export function makeFakes(): Fakes {
  const clock = new FakeClock();
  return {
    kube: new InMemoryKube(() => clock.now()),
    metrics: new FakeMetricsStore(),
    notifier: new FakeNotifier(),
    registry: new FakeRegistry(),
    clock,
  };
}

export function makeContainer(
  fakes: Fakes = makeFakes(),
  config: AppConfig = makeConfig(),
  overrides: Partial<Dependencies> = {},
): { container: Container; fakes: Fakes } {
  const container = buildContainer(config, silentLogger, {
    kube: fakes.kube,
    metrics: fakes.metrics,
    registry: fakes.registry,
    notifier: fakes.notifier,
    clock: fakes.clock,
    ...overrides,
  });
  return { container, fakes };
}

/** A real Postgres-compatible database in memory, created from the shipped migration. */
export async function makePgMemRepository(): Promise<{
  repo: MetricsRepository;
  query: (sql: string) => Promise<Record<string, unknown>[]>;
}> {
  const db = newDb();
  const migration = readFileSync(
    fileURLToPath(new URL('../../migrations/001_devspaces_metrics.sql', import.meta.url)),
    'utf8',
  );
  db.public.none(migration);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return {
    repo: new MetricsRepository(pool),
    query: async (sql) => (await pool.query(sql)).rows as Record<string, unknown>[],
  };
}

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function listen(container: Container): Promise<TestServer> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp(container).listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
