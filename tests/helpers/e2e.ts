import { buildContainer, type Container } from '../../src/container.js';
import { DevfileRegistryClient, createRegistryHttp } from '../../src/infra/devreg/DevfileRegistryClient.js';
import { silentLogger } from '../../src/utils/logger.js';
import { startRegistryServer, type RegistryServer } from './registry-server.js';
import {
  ADMIN,
  listen,
  makeConfig,
  makeFakes,
  makePgMemRepository,
  type Fakes,
  type TestServer,
} from './testkit.js';
import type { InMemoryKube } from './InMemoryKube.js';

// Response bodies are inspected ad hoc by the journey tests, so they are deliberately loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface E2E {
  baseUrl: string;
  container: Container;
  fakes: Fakes;
  registry: RegistryServer;
  sql: (query: string) => Promise<Record<string, unknown>[]>;
  /** Log in over HTTP and return an API caller bound to the resulting token. */
  login(username?: string, password?: string): Promise<{ token: string; call: Caller }>;
  anonymous: Caller;
  stop(): Promise<void>;
}

export type Caller = (method: string, path: string, body?: unknown) => Promise<ApiResult>;

function caller(baseUrl: string, token?: string): Caller {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain text (e.g. /healthz) */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
}

/** Plays the part of the Dev Spaces controller: Starting → Running, Stopping → Stopped. */
export function startControllerSimulation(kube: InMemoryKube, intervalMs = 5): () => void {
  const timer = setInterval(() => {
    for (const dw of kube.workspaces()) {
      const ns = dw.metadata?.namespace ?? '';
      const name = dw.metadata?.name ?? '';
      if (dw.status?.phase === 'Stopping') kube.setPhase(ns, name, 'Stopped');
      else if (!dw.status?.phase || dw.status.phase === 'Starting') {
        kube.setPhase(ns, name, 'Running', `https://${name}.apps.test/`);
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function startE2E(env: Record<string, string> = {}): Promise<E2E> {
  const registry = await startRegistryServer();
  const config = makeConfig({ DEVREG_URL: registry.url, ...env });
  const fakes = makeFakes();
  const db = await makePgMemRepository();
  const container = buildContainer(config, silentLogger, {
    kube: fakes.kube,
    metrics: db.repo,
    registry: new DevfileRegistryClient(createRegistryHttp(registry.url)),
    notifier: fakes.notifier,
    clock: fakes.clock,
  });
  const server: TestServer = await listen(container);
  const anonymous = caller(server.baseUrl);
  return {
    baseUrl: server.baseUrl,
    container,
    fakes,
    registry,
    sql: db.query,
    anonymous,
    async login(username = ADMIN.username, password = ADMIN.password) {
      const res = await anonymous('POST', '/api/v1/login', { username, password });
      if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
      return { token: res.body.token as string, call: caller(server.baseUrl, res.body.token as string) };
    },
    async stop() {
      await server.close();
      await registry.close();
    },
  };
}

export { caller };
