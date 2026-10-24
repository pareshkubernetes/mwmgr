import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { AppConfig } from '../config/env.js';
import type { Principal } from '../types.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { parseSoeid } from '../utils/names.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time string comparison (hashing equalises lengths). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function checkAdminCredentials(auth: AppConfig['auth'], username: string, password: string): boolean {
  // Evaluate both so timing does not reveal which one was wrong.
  const userOk = safeEqual(username, auth.adminUsername);
  const passOk = safeEqual(password, auth.adminPassword);
  return userOk && passOk;
}

export function signToken(auth: AppConfig['auth'], principal: Principal): string {
  return jwt.sign({ role: principal.role }, auth.secretKey, {
    algorithm: 'HS256',
    subject: principal.soeid,
    expiresIn: auth.expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function getPrincipal(res: Response): Principal {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal) throw new UnauthorizedError();
  return principal;
}

/** `Authorization: Bearer <jwt>` → `res.locals.principal`. */
export function authenticate(auth: AppConfig['auth']): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!match?.[1]) return next(new UnauthorizedError('A bearer token is required for authentication'));
    try {
      const decoded = jwt.verify(match[1], auth.secretKey, { algorithms: ['HS256'] });
      if (typeof decoded === 'string' || typeof decoded.sub !== 'string') throw new Error('malformed claims');
      const role = decoded.role === 'admin' ? 'admin' : 'user';
      res.locals.principal = { soeid: decoded.sub, role } satisfies Principal;
      return next();
    } catch {
      return next(new UnauthorizedError('Invalid token'));
    }
  };
}

/** Validates `:soeid` and makes sure the caller may act for that user (admins may act for anyone). */
export function authorizeSoeid(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const soeid = parseSoeid(req.params.soeid ?? '');
      const principal = getPrincipal(res);
      if (principal.role !== 'admin' && principal.soeid.toLowerCase() !== soeid) {
        throw new ForbiddenError('You may only access your own resources');
      }
      res.locals.soeid = soeid;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const getSoeid = (res: Response): string => res.locals.soeid as string;
