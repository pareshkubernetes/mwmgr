import type { RequestHandler } from 'express';
import type { Container } from '../container.js';
import { asyncHandler } from '../http/errors.js';
import { k8sStatus } from '../utils/k8s-errors.js';

function failureDetails(error: unknown) {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const httpStatus = k8sStatus(cause);
  const message = cause instanceof Error ? cause.message : '';
  const reason =
    httpStatus === 401
      ? 'authentication_failed'
      : httpStatus === 403
        ? 'permission_denied'
        : /certificate|ssl|tls/i.test(message)
          ? 'certificate_error'
          : /timeout|timed out|abort/i.test(message)
            ? 'timeout'
            : /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|fetch failed|connect/i.test(message)
              ? 'connection_failed'
              : 'dependency_check_failed';
  return { reason, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function healthCheckController(container: Container) {
  return {
    health: (_req, res) => {
      res.send('OK');
    },
    ready: asyncHandler(async (_req, res) => {
      const checks: Record<string, string> = {};
      const failed = (dependency: string) => (error: unknown) => {
        checks[dependency] = 'unavailable';
        container.logger.error('readiness.check_failed', {
          dependency,
          requestId: res.locals.requestId as string | undefined,
          ...failureDetails(error),
        });
      };
      await Promise.all([
        container.kube.ping().then(() => (checks.kubernetes = 'ok'), failed('kubernetes')),
        container.metrics.ping().then(() => (checks.postgres = 'ok'), failed('postgres')),
        // only when build/deploy projects live on a different cluster
        ...(container.deployKube !== container.kube
          ? [container.deployKube.ping().then(() => (checks.deployCluster = 'ok'), failed('deployCluster'))]
          : []),
      ]);
      const ready = Object.values(checks).every((v) => v === 'ok');
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
    }),
  } satisfies Record<string, RequestHandler>;
}
