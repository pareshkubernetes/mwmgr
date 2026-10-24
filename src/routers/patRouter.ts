import { Router } from 'express';
import type { Container } from '../container.js';
import { patController } from '../controllers/patController.js';

export default function patRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = patController(container);
  router.get('/pats', controller.list);
  router.get('/pats/:tokenName', controller.view);
  router.post('/pats/:tokenName', controller.create);
  router.put('/pats/:tokenName', controller.update);
  router.delete('/pats/:tokenName', controller.remove);
  return router;
}
