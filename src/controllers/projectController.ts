import type { RequestHandler } from 'express';
import { optionalCsiid } from '../http/helpers.js';
import type { Container } from '../container.js';
import { getSoeid } from '../http/auth.js';
import { asyncHandler } from '../http/errors.js';

export function projectController(container: Container) {
  return {
    list: asyncHandler(async function projectList(req, res) {
      const csiid = optionalCsiid(req);
      const projects = await container.namespaces.listProjects(getSoeid(res));
      res.json(csiid ? projects.filter((project) => project.csiid === csiid) : projects);
    }),
  } satisfies Record<string, RequestHandler>;
}
