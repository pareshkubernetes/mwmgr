import { Router } from 'express';
import type { Container } from '../container.js';
import { stackController } from '../controllers/stackController.js';
export default function stackRouter(container: Container) {
  const router = Router({ mergeParams: true });
  router.get('/stacks', stackController(container).list);
  return router;
}
