import { Router } from 'express';
import type { Container } from '../container.js';
import { healthCheckController } from '../controllers/healthCheckController.js';

export default function healthCheckRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = healthCheckController(container);
  router.get('/healthz', controller.health);
  router.get('/readyz', controller.ready);
  return router;
}
