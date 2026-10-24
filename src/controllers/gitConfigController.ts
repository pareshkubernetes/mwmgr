import type { RequestHandler } from 'express';
import type { Container } from '../container.js';
import { getSoeid } from '../http/auth.js';
import { asyncHandler } from '../http/errors.js';
import { csiidQuerySchema, gitConfigBodySchema, parse } from '../http/schemas.js';
import { parseCsiid } from '../utils/names.js';

export function gitConfigController(container: Container) {
  return {
    view: asyncHandler(async function gitConfigView(req, res) {
      const { csiid } = parse(csiidQuerySchema, req.query);
      res.json(await container.gitConfig.view(getSoeid(res), parseCsiid(csiid)));
    }),
    upsert: asyncHandler(async function gitConfigUpsert(req, res) {
      const body = parse(gitConfigBodySchema, req.body);
      res.json(await container.gitConfig.upsert(getSoeid(res), parseCsiid(body.csiid), body.content));
    }),
    remove: asyncHandler(async function gitConfigRemove(req, res) {
      const { csiid } = parse(csiidQuerySchema, req.query);
      const removed = await container.gitConfig.delete(getSoeid(res), parseCsiid(csiid));
      res.json({ message: removed ? 'Git config deleted.' : 'Git config not found; nothing to delete.' });
    }),
  } satisfies Record<string, RequestHandler>;
}
