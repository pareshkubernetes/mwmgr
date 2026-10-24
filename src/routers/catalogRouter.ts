import { Router } from 'express';
import type { Container } from '../container.js';
import { catalogController } from '../controllers/catalogController.js';

export default function catalogRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = catalogController(container);
  router.get('/catalog', controller.list);
  return router;
}
