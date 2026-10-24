import type { RequestHandler } from 'express';
import { param } from '../http/helpers.js';
import type { Container } from '../container.js';
import { getSoeid } from '../http/auth.js';
import { asyncHandler } from '../http/errors.js';
import { csiidQuerySchema, parse, patBodySchema } from '../http/schemas.js';
import { parseCsiid, parseTokenName } from '../utils/names.js';

export function patController(container: Container) {
  return {
    list: asyncHandler(async (_req, res) => {
      res.json(await container.pats.list(getSoeid(res)));
    }),
    view: asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidQuerySchema, req.query);
      res.json(
        await container.pats.view(getSoeid(res), parseCsiid(csiid), parseTokenName(param(req, 'tokenName'))),
      );
    }),
    create: asyncHandler(async (req, res) => {
      const body = parse(patBodySchema, req.body);
      const created = await container.pats.create(
        getSoeid(res),
        parseCsiid(body.csiid),
        parseTokenName(param(req, 'tokenName')),
        body.token,
      );
      res.status(201).json(created);
    }),
    update: asyncHandler(async (req, res) => {
      const body = parse(patBodySchema, req.body);
      res.json(
        await container.pats.update(
          getSoeid(res),
          parseCsiid(body.csiid),
          parseTokenName(param(req, 'tokenName')),
          body.token,
        ),
      );
    }),
    remove: asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidQuerySchema, req.query);
      const tokenName = parseTokenName(param(req, 'tokenName'));
      const removed = await container.pats.delete(getSoeid(res), parseCsiid(csiid), tokenName);
      res.json({
        message: removed ? `PAT '${tokenName}' deleted.` : `PAT '${tokenName}' not found; nothing to delete.`,
      });
    }),
  } satisfies Record<string, RequestHandler>;
}
