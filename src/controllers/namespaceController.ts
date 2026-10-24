import type { Container } from '../container.js';
import { getSoeid } from '../http/auth.js';
import { asyncHandler } from '../http/errors.js';
import { csiidBodySchema, parse } from '../http/schemas.js';
import { parseCsiid } from '../utils/names.js';

export function namespaceController(container: Container) {
  return {
    create: asyncHandler(async function namespaceCreate(req, res) {
      const { csiid } = parse(csiidBodySchema, req.body);
      const result = await container.namespaces.ensure(getSoeid(res), parseCsiid(csiid));
      res.status(result.created ? 201 : 200).json(result);
    }),
  };
}
