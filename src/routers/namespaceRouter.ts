import { Router } from 'express';
import type { Container } from '../container.js';
import { namespaceController } from '../controllers/namespaceController.js';

export default function namespaceRouter(container: Container) {
  const router = Router({ mergeParams: true });
  router.post('/projects', namespaceController(container).create);
  return router;
}
