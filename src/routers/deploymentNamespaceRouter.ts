import { Router } from 'express';
import type { Container } from '../container.js';
import { deploymentNamespaceController } from '../controllers/deploymentNamespaceController.js';

export default function deploymentNamespaceRouter(container: Container) {
  const router = Router({ mergeParams: true });
  const controller = deploymentNamespaceController(container);
  router.get('/deployment-projects', controller.list);
  router.post('/deployment-projects', controller.create);
  router.delete('/deployment-projects', controller.remove);
  return router;
}
