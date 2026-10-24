import { Router } from 'express';
import type { Container } from '../container.js';
import { workspaceController } from '../controllers/workspaceController.js';

export default function workspaceRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = workspaceController(container);
  router.get('/workspaces', controller.list);
  router.get('/workspaces/:id', controller.get);
  router.post('/workspaces', controller.create);
  router.delete('/workspaces/:id', controller.remove);
  router.post('/workspaces/:id/start', controller.start);
  router.post('/workspaces/:id/stop', controller.stop);
  return router;
}
