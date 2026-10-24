import { Router } from 'express';
import type { Container } from '../container.js';
import { projectController } from '../controllers/projectController.js';

export default function projectRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = projectController(container);
  router.get('/projects', controller.list);
  return router;
}
