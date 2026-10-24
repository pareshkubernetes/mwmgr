import axios, { AxiosError } from 'axios';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UpstreamError,
  errorMessage,
} from '../../../src/utils/errors.js';
import { describeError, isK8sStatus, k8sStatus, toAppError } from '../../../src/utils/k8s-errors.js';

describe('k8sStatus', () => {
  it('reads code, statusCode, response.status and body.code', () => {
    expect(k8sStatus({ code: 404 })).toBe(404);
    expect(k8sStatus({ statusCode: 403 })).toBe(403);
    expect(k8sStatus({ response: { status: 409 } })).toBe(409);
    expect(k8sStatus({ body: { code: 500 } })).toBe(500);
    expect(k8sStatus({ body: JSON.stringify({ code: 422 }) })).toBe(422);
  });
  it('is undefined for non-http errors', () => {
    expect(k8sStatus(new Error('x'))).toBeUndefined();
    expect(k8sStatus(null)).toBeUndefined();
    expect(k8sStatus('boom')).toBeUndefined();
    expect(k8sStatus({ body: 'not json' })).toBeUndefined();
  });
  it('isK8sStatus compares', () => {
    expect(isK8sStatus({ code: 404 }, 404)).toBe(true);
    expect(isK8sStatus({ code: 404 }, 403)).toBe(false);
  });
});

describe('describeError', () => {
  it('describes kubernetes api errors with the server message', () => {
    expect(describeError('ctx', { code: 422, body: { message: 'invalid spec' } })).toBe(
      'ctx: Kubernetes API error (422) invalid spec',
    );
  });
  it('describes 404 plainly', () => {
    expect(describeError('ctx', { code: 404 })).toBe('ctx: Resource not found (404)');
  });
  it('describes axios errors', () => {
    const withResponse = new AxiosError('boom', 'ERR', undefined, {}, { status: 503, data: {} } as never);
    expect(describeError('ctx', withResponse)).toBe('ctx: HTTP 503 boom');
    const noResponse = new AxiosError('down', 'ECONNREFUSED', undefined, {});
    expect(describeError('ctx', noResponse)).toBe('ctx: No response received from server');
    const bare = new AxiosError('odd');
    expect(axios.isAxiosError(bare)).toBe(true);
    expect(describeError('ctx', bare)).toBe('ctx: Axios error odd');
  });
  it('flags TLS problems', () => {
    expect(describeError('ctx', new Error('self signed certificate in chain'))).toBe(
      'ctx: TLS/SSL certificate error',
    );
  });
  it('falls back to the message or string form', () => {
    expect(describeError('ctx', new Error('plain'))).toBe('ctx: plain');
    expect(describeError('ctx', 'text')).toBe('ctx: text');
  });
});

describe('toAppError', () => {
  it('maps statuses to typed errors and keeps the cause', () => {
    const cause = { code: 404 };
    const notFound = toAppError('ctx', cause);
    expect(notFound).toBeInstanceOf(NotFoundError);
    expect((notFound as { cause?: unknown }).cause).toBe(cause);
    expect(toAppError('ctx', { code: 403 })).toBeInstanceOf(ForbiddenError);
    expect(toAppError('ctx', { code: 409 })).toBeInstanceOf(ConflictError);
    const upstream = toAppError('ctx', { code: 500 });
    expect(upstream).toBeInstanceOf(UpstreamError);
    expect(upstream.status).toBe(502);
  });
  it('passes AppErrors through untouched', () => {
    const original = new ConflictError('x');
    expect(toAppError('ctx', original)).toBe(original);
  });
  it('wraps unknown failures as upstream errors', () => {
    expect(toAppError('ctx', new Error('weird'))).toBeInstanceOf(UpstreamError);
  });
});

describe('errors', () => {
  it('carry status, code and class name', () => {
    const e = new NotFoundError('nope');
    expect(e).toBeInstanceOf(AppError);
    expect([e.status, e.code, e.name]).toEqual([404, 'NOT_FOUND', 'NotFoundError']);
  });
  it('errorMessage handles non-errors', () => {
    expect(errorMessage(new Error('a'))).toBe('a');
    expect(errorMessage(42)).toBe('42');
  });
});
