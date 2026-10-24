import type { Server } from 'node:http';
import { loadConfig } from './config/env.js';
import { buildContainer, createProductionDependencies } from './container.js';
import { createApp } from './http/app.js';
import { createLogger } from './utils/logger.js';
import { errorMessage } from './utils/errors.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const container = buildContainer(config, logger, createProductionDependencies(config, logger));
  const server: Server = createApp(container).listen(config.port, () =>
    logger.info('server.listening', { port: config.port, cluster: config.cluster.apiUrl }),
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown', { signal });
    server.close(() => {
      container.metrics.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${errorMessage(error)}\n`);
  process.exit(1);
});
