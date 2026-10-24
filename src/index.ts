import type { Server } from 'node:http';
import { loadConfig, startupSummary } from './config/env.js';
import { buildContainer, createProductionDependencies } from './container.js';
import { createApp } from './app.js';
import { createLogger } from './utils/logger.js';
import { flushDailyLogs } from './config/daily-logs.js';

async function main(): Promise<void> {
  // Optional CLI argument: node dist/index.js <kubeconfig>
  const config = loadConfig(
    process.argv[2] ? { ...process.env, KUBECONFIG_PATH: process.argv[2] } : process.env,
  );
  const logger = createLogger(
    config.logLevel,
    undefined,
    {},
    { format: config.logFormat, color: config.logColor, dailyFiles: true },
  );
  if (!config.cluster.tlsRejectUnauthorized) {
    logger.warn('cluster.tls_verification_disabled', {
      reason: 'NODE_TLS_REJECT_UNAUTHORIZED=0',
      risk: 'the clusters, the devfile registry and other HTTPS peers are not verified',
    });
  }
  const dependencies = createProductionDependencies(config, logger);
  const container = buildContainer(config, logger, dependencies, (next) => {
    // Runtime settings do not change PostgreSQL; retain its existing pool.
    const adapters = createProductionDependencies(
      { ...next, postgres: { ...next.postgres, enabled: false } },
      logger,
    );
    return { ...adapters, metrics: dependencies.metrics };
  });
  const server: Server = createApp(container).listen(config.port, function onListening() {
    logger.success('server.listening', startupSummary(config));
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown', { signal });
    server.close(() => {
      container.metrics.close().finally(async () => {
        await flushDailyLogs();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(function onStartupError(error: unknown) {
  const logger = createLogger(
    'error',
    (line) => process.stderr.write(`${line}\n`),
    {},
    { format: 'pretty', color: false, dailyFiles: true },
  );
  logger.error('server.start_failed', { error });
  void flushDailyLogs().then(() => process.exit(1));
});
