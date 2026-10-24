import { Router } from 'express';
import { logController } from '../controllers/logController.js';
export default function logRouter() {
  const router = Router();
  router.get('/', logController().list);
  return router;
}
