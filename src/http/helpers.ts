import type { Request, RequestHandler } from 'express';
import { getPrincipal } from '../http/auth.js';
import { ForbiddenError } from '../utils/errors.js';
import { parse } from '../http/schemas.js';
import { csiidQuerySchema } from '../http/schemas.js';
import { parseCsiid } from '../utils/names.js';

export const param = (req: Request, name: string): string => req.params[name] ?? '';

export const optionalCsiid = (req: Request): string | undefined =>
  req.query.csiid === undefined ? undefined : parseCsiid(parse(csiidQuerySchema, req.query).csiid);

export const requireAdmin: RequestHandler = (_req, res, next) => {
  try {
    if (getPrincipal(res).role !== 'admin') throw new ForbiddenError('Administrator access required');
    next();
  } catch (error) {
    next(error);
  }
};
