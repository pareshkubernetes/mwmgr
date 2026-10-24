import { Router } from 'express';
import type { Container } from '../container.js';
import { gitConfigController } from '../controllers/gitConfigController.js';

export default function gitConfigRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = gitConfigController(container);
  router.get('/gitconfig', controller.view);
  router.put('/gitconfig', controller.upsert);
  router.post('/gitconfig', controller.upsert);
  router.delete('/gitconfig', controller.remove);
  return router;
}
