import type { RequestHandler } from 'express';
import type { Container } from '../container.js';
import { asyncHandler } from '../http/errors.js';

export function catalogController(container: Container) {
  return {
    list: asyncHandler(async (_req, res) => {
      res.json(await container.registry.getCatalog());
    }),
  } satisfies Record<string, RequestHandler>;
}
