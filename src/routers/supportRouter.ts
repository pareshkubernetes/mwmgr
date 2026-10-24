import { Router } from 'express';
import type { Container } from '../container.js';
import { supportController } from '../controllers/supportController.js';
export default function supportRouter(container: Container) {
  const router = Router();
  router.put('/resources', supportController(container).apply);
  return router;
}
