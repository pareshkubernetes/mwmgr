import { Router } from 'express';
import { requireAdmin } from '../http/helpers.js';
import type { Container } from '../container.js';
import { authenticate, authorizeSoeid } from '../http/auth.js';
import authRouter from './authRouter.js';
import catalogRouter from './catalogRouter.js';
import configurationRouter from './configurationRouter.js';
import deploymentNamespaceRouter from './deploymentNamespaceRouter.js';
import gitConfigRouter from './gitConfigRouter.js';
import healthCheckRouter from './healthCheckRouter.js';
import logRouter from './logRouter.js';
import namespaceRouter from './namespaceRouter.js';
import patRouter from './patRouter.js';
import projectRouter from './projectRouter.js';
import stackRouter from './stackRouter.js';
import supportRouter from './supportRouter.js';
import workspaceRouter from './workspaceRouter.js';

export default function baseRouter(container: Container) {
  const api = Router();
  api.use(healthCheckRouter(container));
  api.use(authRouter(container));
  api.use('/support', authenticate(container.config.auth), requireAdmin, supportRouter(container));
  api.use(
    '/configuration',
    authenticate(container.config.auth),
    requireAdmin,
    configurationRouter(container),
  );
  api.use('/logs', authenticate(container.config.auth), requireAdmin, logRouter());
  api.use('/catalog', authenticate(container.config.auth));
  api.use(catalogRouter(container));
  const user = Router({ mergeParams: true });
  user.use(stackRouter(container));
  user.use(projectRouter(container));
  user.use(namespaceRouter(container));
  user.use(workspaceRouter(container));
  user.use(patRouter(container));
  user.use(gitConfigRouter(container));
  user.use(deploymentNamespaceRouter(container));
  api.use('/:soeid', authenticate(container.config.auth), authorizeSoeid(), user);
  return api;
}
