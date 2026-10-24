import type { Express } from 'express';
import request from 'supertest';
import { buildContainer, type Container } from '../../src/container.js';
import { createApp } from '../../src/app.js';
import { signToken } from '../../src/http/auth.js';
import { DevfileRegistryClient, createRegistryHttp } from '../../src/infra/devreg/DevfileRegistryClient.js';
import { silentLogger, type Logger } from '../../src/utils/logger.js';
import { makeConfig, makeFakes, makePgMemRepository, type Fakes } from './testkit.js';
import { startRegistryServer, type RegistryServer } from './registry-server.js';
import type { InMemoryKube } from './InMemoryKube.js';

export interface Integration {
  app: Express;
  container: Container;
  fakes: Fakes;
  registry: RegistryServer;
  token: string;
  /** Run SQL against the in-memory metrics database. */
  sql: (query: string) => Promise<Record<string, unknown>[]>;
  /** Rows of the metrics table, oldest first. */
  metricsRows: () => Promise<Record<string, unknown>[]>;
  api: (method: 'get' | 'post' | 'put' | 'delete', path: string) => request.Test;
  close(): Promise<void>;
}

/**
 * Real routes, services, SQL (pg-mem) and HTTP devfile registry; only the cluster is in memory.
 */
export async function startIntegration(
  env: Record<string, string> = {},
  options: { deployKube?: InMemoryKube; logger?: Logger } = {},
): Promise<Integration> {
  const registry = await startRegistryServer();
  const config = makeConfig({ DEVREG_URL: registry.url, ...env });
  const fakes = makeFakes();
  const db = await makePgMemRepository();
  const container = buildContainer(config, options.logger ?? silentLogger, {
    kube: fakes.kube,
    deployKube: options.deployKube,
    metrics: db.repo,
    registry: new DevfileRegistryClient(createRegistryHttp(registry.url)),
    notifier: fakes.notifier,
    clock: fakes.clock,
  });
  const app = createApp(container);
  const token = signToken(config.auth, { soeid: config.auth.adminUsername, role: 'admin' });
  return {
    app,
    container,
    fakes,
    registry,
    token,
    sql: db.query,
    metricsRows: () => db.query('SELECT * FROM metrics."devspaces-metrics" ORDER BY id'),
    api: (method, path) => request(app)[method](path).set('Authorization', `Bearer ${token}`),
    close: () => registry.close(),
  };
}
