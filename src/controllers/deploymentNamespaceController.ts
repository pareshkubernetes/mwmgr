import type { Request, RequestHandler, Response } from 'express';
import { optionalCsiid } from '../http/helpers.js';
import type { Container } from '../container.js';
import { getSoeid } from '../http/auth.js';
import { asyncHandler } from '../http/errors.js';
import { csiidBodySchema, parse } from '../http/schemas.js';
import { csiidFromDeploymentNamespace, parseCsiid } from '../utils/names.js';

export function deploymentNamespaceController(container: Container) {
  return {
    list: asyncHandler(async (req, res) => {
      const csiid = optionalCsiid(req);
      const projects = await container.deployments.list(getSoeid(res));
      res.json(csiid ? projects.filter((name) => csiidFromDeploymentNamespace(name) === csiid) : projects);
    }),
    create: asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidBodySchema, req.body);
      const result = await container.deployments.ensure(getSoeid(res), parseCsiid(csiid));
      res.status(result.exists ? 200 : 201).json(result);
    }),
    remove: asyncHandler(async (_req: Request, res: Response) => {
      res.json(await container.deployments.delete(getSoeid(res)));
    }),
  } satisfies Record<string, RequestHandler>;
}
