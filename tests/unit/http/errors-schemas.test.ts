import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { asyncHandler, createErrorHandler, errorBody, notFoundHandler } from '../../../src/http/errors.js';
import {
  createWorkspaceSchema,
  gitConfigBodySchema,
  loginSchema,
  parse,
  patBodySchema,
} from '../../../src/http/schemas.js';
import { BadRequestError, ConflictError, UpstreamError } from '../../../src/utils/errors.js';
import { createLogger } from '../../../src/utils/logger.js';

function fakeRes() {
  const res = {
    locals: { requestId: 'rid' },
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function handle(err: unknown) {
  const logs: Record<string, unknown>[] = [];
  const handler = createErrorHandler(createLogger('debug', (l) => logs.push(JSON.parse(l))));
  const res = fakeRes();
  let forwarded: unknown;
  handler(
    err,
    { path: '/x' } as Request,
    res as unknown as Response,
    ((e?: unknown) => (forwarded = e)) as NextFunction,
  );
  return { res, logs, forwarded };
}

describe('error handler', () => {
  it('maps AppErrors to their status and the standard body', () => {
    const { res } = handle(new ConflictError('taken', 'PAT_EXISTS'));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'taken', message: 'taken', code: 'PAT_EXISTS' });
  });

  it('logs 5xx AppErrors but not 4xx', () => {
    expect(handle(new UpstreamError('cluster down')).logs).toHaveLength(1);
    expect(handle(new BadRequestError('bad')).logs).toHaveLength(0);
  });

  it('maps body-parser failures', () => {
    expect(handle(Object.assign(new Error('x'), { type: 'entity.parse.failed' })).res.statusCode).toBe(400);
    expect(handle(Object.assign(new Error('x'), { type: 'entity.too.large' })).res.statusCode).toBe(413);
  });

  it('hides internals of unexpected errors', () => {
    const { res, logs } = handle(new Error('db password is hunter2'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Internal server error',
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(logs[0]).toMatchObject({ event: 'request.crashed', requestId: 'rid' });
  });

  it('defers to express when headers are already sent', () => {
    const logs: string[] = [];
    const handler = createErrorHandler(createLogger('debug', (l) => logs.push(l)));
    const res = { ...fakeRes(), headersSent: true };
    let forwarded: unknown;
    const err = new Error('late');
    handler(
      err,
      {} as Request,
      res as unknown as Response,
      ((e?: unknown) => (forwarded = e)) as NextFunction,
    );
    expect(forwarded).toBe(err);
  });

  it('404 handler names the route', () => {
    const res = fakeRes();
    notFoundHandler(
      { method: 'GET', path: '/nope' } as Request,
      res as unknown as Response,
      (() => undefined) as NextFunction,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(errorBody('Route not found: GET /nope', 'ROUTE_NOT_FOUND'));
  });
});

describe('asyncHandler', () => {
  it('forwards rejections to next()', async () => {
    const boom = new Error('async boom');
    let forwarded: unknown;
    asyncHandler(async () => {
      throw boom;
    })({} as Request, {} as Response, ((e?: unknown) => (forwarded = e)) as NextFunction);
    await new Promise((r) => setImmediate(r));
    expect(forwarded).toBe(boom);
  });
});

describe('createWorkspaceSchema', () => {
  const ok = { devworkspaceValue: 'java-maven', csiid: '177398' };

  it('applies defaults and accepts numeric csiid', () => {
    expect(parse(createWorkspaceSchema, { ...ok, csiid: 177398 })).toEqual({ ...ok, editor: 'vscode' });
  });
  it('accepts all optional fields', () => {
    const body = {
      ...ok,
      editor: 'goland',
      stackVersion: '2.0.0',
      repositoryUrl: 'https://github.com/acme/app.git',
      repositoryBranch: 'feature/x-1',
    };
    expect(parse(createWorkspaceSchema, body)).toMatchObject(body);
  });
  it.each([
    ['missing stack', { csiid: '1' }],
    ['non-numeric csiid', { ...ok, csiid: 'abc' }],
    ['unknown editor', { ...ok, editor: 'emacs' }],
    ['stack with slash', { ...ok, devworkspaceValue: '../etc' }],
    ['http repo url', { ...ok, repositoryUrl: 'http://github.com/a/b' }],
    ['ssh repo url', { ...ok, repositoryUrl: 'git@github.com:a/b.git' }],
    ['bad branch', { ...ok, repositoryBranch: 'a b;rm' }],
    ['unknown property', { ...ok, admin: true }],
    ['empty body', undefined],
  ])('rejects %s with a 400 listing the problem', (_l, body) => {
    expect(() => parse(createWorkspaceSchema, body)).toThrow(BadRequestError);
  });
});

describe('other schemas', () => {
  it('login needs both fields and nothing else', () => {
    expect(parse(loginSchema, { username: 'a', password: 'b' })).toEqual({ username: 'a', password: 'b' });
    expect(() => parse(loginSchema, { username: 'a' })).toThrow(BadRequestError);
    expect(() => parse(loginSchema, { username: 'a', password: 'b', extra: 1 })).toThrow(BadRequestError);
  });
  it('pat and gitconfig bodies', () => {
    expect(parse(patBodySchema, { csiid: 5, token: 't' })).toEqual({ csiid: '5', token: 't' });
    expect(() => parse(patBodySchema, { csiid: '5' })).toThrow(BadRequestError);
    expect(parse(gitConfigBodySchema, { csiid: '5', content: 'x' }).content).toBe('x');
    expect(() => parse(gitConfigBodySchema, { csiid: '5', content: '' })).toThrow(BadRequestError);
  });
  it('error messages name the field', () => {
    try {
      parse(createWorkspaceSchema, { devworkspaceValue: 'x', csiid: 'abc' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('csiid');
      expect((e as BadRequestError).code).toBe('VALIDATION_ERROR');
    }
  });
});
