import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  authenticate,
  authorizeSoeid,
  checkAdminCredentials,
  getPrincipal,
  safeEqual,
  signToken,
} from '../../../src/http/auth.js';
import { ForbiddenError, UnauthorizedError, BadRequestError } from '../../../src/utils/errors.js';

const auth = {
  secretKey: 'unit-test-secret-0123456789',
  adminUsername: 'admin',
  adminPassword: 'pw',
  expiresIn: '1h',
};

function run(handler: (req: Request, res: Response, next: NextFunction) => void, req: Partial<Request>) {
  const res = { locals: {} } as Response;
  let error: unknown;
  let called = false;
  handler({ headers: {}, params: {}, ...req } as Request, res, ((e?: unknown) => {
    called = true;
    error = e;
  }) as NextFunction);
  return { res, error, called };
}

describe('safeEqual / checkAdminCredentials', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
    expect(safeEqual('a', 'aa')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
  it('requires both username and password', () => {
    expect(checkAdminCredentials(auth, 'admin', 'pw')).toBe(true);
    expect(checkAdminCredentials(auth, 'admin', 'x')).toBe(false);
    expect(checkAdminCredentials(auth, 'x', 'pw')).toBe(false);
    expect(checkAdminCredentials(auth, '', '')).toBe(false);
  });
});

describe('signToken', () => {
  it('issues an HS256 token with subject and role', () => {
    const token = signToken(auth, { soeid: 'admin', role: 'admin' });
    const decoded = jwt.verify(token, auth.secretKey, { complete: true });
    expect(decoded.header.alg).toBe('HS256');
    expect(decoded.payload).toMatchObject({ sub: 'admin', role: 'admin' });
  });
});

describe('authenticate', () => {
  const mw = authenticate(auth);
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  it('accepts a valid token and exposes the principal', () => {
    const { res, error } = run(mw, bearer(signToken(auth, { soeid: 'admin', role: 'admin' })));
    expect(error).toBeUndefined();
    expect(getPrincipal(res)).toEqual({ soeid: 'admin', role: 'admin' });
  });

  it('treats anything but role=admin as a plain user', () => {
    const token = jwt.sign({ role: 'root' }, auth.secretKey, { subject: 'pp1' });
    expect(getPrincipal(run(mw, bearer(token)).res).role).toBe('user');
  });

  it.each([
    ['no header', {}],
    ['wrong scheme', { headers: { authorization: 'Basic abc' } }],
    ['no token', { headers: { authorization: 'Bearer' } }],
    ['garbage', bearer('not.a.jwt')],
    ['wrong secret', bearer(jwt.sign({}, 'another-secret-another-secret', { subject: 'x' }))],
    ['expired', bearer(jwt.sign({}, auth.secretKey, { subject: 'x', expiresIn: -10 }))],
    ['no subject', bearer(jwt.sign({ role: 'admin' }, auth.secretKey))],
    [
      'alg none',
      bearer(
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`,
      ),
    ],
    ['other algorithm', bearer(jwt.sign({}, auth.secretKey, { subject: 'x', algorithm: 'HS512' }))],
  ] as const)('rejects %s with 401', (_label, req) => {
    const { error } = run(mw, req as Partial<Request>);
    expect(error).toBeInstanceOf(UnauthorizedError);
  });
});

describe('authorizeSoeid', () => {
  const mw = authorizeSoeid();
  const withPrincipal = (principal: unknown, soeid: string) => {
    const res = { locals: { principal } } as unknown as Response;
    let error: unknown;
    mw({ params: { soeid } } as unknown as Request, res, ((e?: unknown) => (error = e)) as NextFunction);
    return { res, error };
  };

  it('lets an admin act for any valid user and normalises the id', () => {
    const { res, error } = withPrincipal({ soeid: 'admin', role: 'admin' }, 'PP58386');
    expect(error).toBeUndefined();
    expect(res.locals.soeid).toBe('pp58386');
  });
  it('lets a user act for themselves only', () => {
    expect(withPrincipal({ soeid: 'PP1', role: 'user' }, 'pp1').error).toBeUndefined();
    expect(withPrincipal({ soeid: 'pp1', role: 'user' }, 'pp2').error).toBeInstanceOf(ForbiddenError);
  });
  it('rejects malformed and reserved ids', () => {
    for (const bad of ['a/b', '..', 'api', 'login', '']) {
      expect(withPrincipal({ soeid: 'admin', role: 'admin' }, bad).error).toBeInstanceOf(BadRequestError);
    }
  });
  it('requires an authenticated principal', () => {
    expect(withPrincipal(undefined, 'pp1').error).toBeInstanceOf(UnauthorizedError);
  });
});
