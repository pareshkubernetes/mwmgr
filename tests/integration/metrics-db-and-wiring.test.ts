import { describe, expect, it } from 'vitest';
import { createProductionDependencies, buildContainer } from '../../src/container.js';
import { NoopMetricsStore } from '../../src/infra/db/MetricsRepository.js';
import { EmailNotifier, NoopNotifier } from '../../src/infra/email/EmailNotifier.js';
import { MetricsRecorder } from '../../src/services/MetricsRecorder.js';
import { silentLogger } from '../../src/utils/logger.js';
import { FakeClock } from '../helpers/fakes.js';
import { makeConfig, makePgMemRepository, writeTestKubeconfig } from '../helpers/testkit.js';

const kubeconfig = writeTestKubeconfig();

describe('metrics table (migration + repository on a real SQL engine)', () => {
  it('stores every column of a record', async () => {
    const { repo, query } = await makePgMemRepository();
    await repo.insert({
      timestamp: new Date('2026-03-04T05:06:07Z'),
      csiid: '1001',
      soeid: 'pp1',
      eventtype: 'create',
      resourcename: 'java-maven-ab12',
      resourcetype: 'workspace',
      status: { failed: false, error: '', message: 'ok' },
      useraction: 'user',
      limitcpu: 2.5,
      limitmemory: 4,
      requestcpu: 0.5,
      requestmemory: 1,
      duration: '1 minute',
      storage: 3,
      workspaceversion: '2.0.0',
      editorname: 'vscode',
    });
    const [row] = await query('SELECT * FROM metrics."devspaces-metrics"');
    expect(row).toMatchObject({
      csiid: '1001',
      soeid: 'pp1',
      eventtype: 'create',
      resourcename: 'java-maven-ab12',
      resourcetype: 'workspace',
      duration: '1 minute',
      useraction: 'user',
      workspaceversion: '2.0.0',
      editorname: 'vscode',
      status: { failed: false, error: '', message: 'ok' },
    });
    expect(Number(row?.limitcpu)).toBe(2.5);
    expect(Number(row?.storage)).toBe(3);
    expect(new Date(String(row?.timestamp)).toISOString()).toBe('2026-03-04T05:06:07.000Z');
    expect(row?.id).toBeDefined();
  });

  it('supports the dashboard questions: counts per stack and failures', async () => {
    const { repo, query } = await makePgMemRepository();
    const recorder = new MetricsRecorder(repo, new FakeClock(), silentLogger);
    const base = { soeid: 'pp1', eventtype: 'create', resourcetype: 'workspace' } as const;
    await recorder.record({ ...base, resourcename: 'a', workspaceversion: '1' });
    await recorder.record({ ...base, soeid: 'pp2', resourcename: 'b', workspaceversion: '1' });
    await recorder.record({
      ...base,
      resourcename: 'c',
      status: { failed: true, error: 'quota', message: '' },
    });

    const users = await query('SELECT COUNT(DISTINCT soeid) AS n FROM metrics."devspaces-metrics"');
    expect(Number(users[0]?.n)).toBe(2);
    const failed = await query(
      `SELECT resourcename FROM metrics."devspaces-metrics" WHERE status->>'failed' = 'true'`,
    );
    expect(failed).toEqual([{ resourcename: 'c' }]);
  });

  it('pings and the recorder survives a broken table', async () => {
    const { repo } = await makePgMemRepository();
    await expect(repo.ping()).resolves.toBeUndefined();
    const broken = new (class extends Object {
      async insert(): Promise<void> {
        throw new Error('relation "metrics.devspaces-metrics" does not exist');
      }
      async ping(): Promise<void> {}
      async close(): Promise<void> {}
    })();
    await expect(
      new MetricsRecorder(broken, new FakeClock(), silentLogger).record({
        soeid: 'pp1',
        eventtype: 'create',
        resourcetype: 'workspace',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('production wiring', () => {
  it('fails fast at startup when there is no cluster configuration', () => {
    const config = makeConfig({ KUBECONFIG_PATH: '/no/such/file' });
    expect(() => createProductionDependencies(config, silentLogger)).toThrow();
  });

  it('uses no-op adapters when Postgres and mail are disabled', () => {
    const config = makeConfig({ KUBECONFIG_PATH: kubeconfig });
    const deps = createProductionDependencies(config, silentLogger);
    expect(deps.metrics).toBeInstanceOf(NoopMetricsStore);
    expect(deps.notifier).toBeInstanceOf(NoopNotifier);
    expect(deps.registry).toBeDefined();
    expect(deps.kube).toBeDefined();
  });

  it('uses the email notifier and a user directory when configured', () => {
    const config = makeConfig({
      KUBECONFIG_PATH: kubeconfig,
      NOTIFICATION_MAIL_URL: 'http://mail.test',
      USER_DIRECTORY_GRAPHQL_URL: 'http://dir.test/graphql',
    });
    expect(createProductionDependencies(config, silentLogger).notifier).toBeInstanceOf(EmailNotifier);
  });

  it('builds a container exposing every service', () => {
    const config = makeConfig({ KUBECONFIG_PATH: kubeconfig });
    const container = buildContainer(
      config,
      silentLogger,
      createProductionDependencies(config, silentLogger),
    );
    expect(Object.keys(container).sort()).toEqual(
      [
        'config',
        'deployments',
        'gitConfig',
        'kube',
        'logger',
        'metrics',
        'namespaces',
        'pats',
        'recorder',
        'registry',
        'workspaces',
      ].sort(),
    );
  });
});
