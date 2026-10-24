import { Router } from 'express';
import type { Container } from '../container.js';
import { configurationController } from '../controllers/configurationController.js';
export default function configurationRouter(container: Container) {
  const router = Router();
  const controller = configurationController(container);
  router.get('/', controller.view);
  router.patch('/', controller.update);
  return router;
}
