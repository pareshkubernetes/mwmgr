import type { RequestHandler } from 'express';
import type { Container } from '../container.js';
import { checkAdminCredentials, signToken } from '../http/auth.js';
import { loginSchema, parse } from '../http/schemas.js';
import { UnauthorizedError } from '../utils/errors.js';

export function authController(container: Container) {
  return {
    login: function login(req, res, next) {
      try {
        const { username, password } = parse(loginSchema, req.body);
        if (!checkAdminCredentials(container.config.auth, username, password)) {
          throw new UnauthorizedError('Username or password is incorrect');
        }
        res.json({ token: signToken(container.config.auth, { soeid: username, role: 'admin' }) });
      } catch (error) {
        next(error);
      }
    },
  } satisfies Record<string, RequestHandler>;
}
