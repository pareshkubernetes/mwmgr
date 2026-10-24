import type { RequestHandler } from 'express';
import type { Container } from '../container.js';
import { asyncHandler } from '../http/errors.js';

export function healthCheckController(container: Container) {
  return {
    health: (_req, res) => {
      res.send('OK');
    },
    ready: asyncHandler(async (_req, res) => {
      const checks: Record<string, string> = {};
      await Promise.all([
        container.kube.ping().then(
          () => (checks.kubernetes = 'ok'),
          () => (checks.kubernetes = 'unavailable'),
        ),
        container.metrics.ping().then(
          () => (checks.postgres = 'ok'),
          () => (checks.postgres = 'unavailable'),
        ),
        // only when build/deploy projects live on a different cluster
        ...(container.deployKube !== container.kube
          ? [
              container.deployKube.ping().then(
                () => (checks.deployCluster = 'ok'),
                () => (checks.deployCluster = 'unavailable'),
              ),
            ]
          : []),
      ]);
      const ready = Object.values(checks).every((v) => v === 'ok');
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
    }),
  } satisfies Record<string, RequestHandler>;
}
