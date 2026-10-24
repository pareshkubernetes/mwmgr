import { Router } from 'express';
import type { Container } from '../container.js';
import { authController } from '../controllers/authController.js';

export default function authRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = authController(container);
  router.post('/login', controller.login);
  return router;
}
