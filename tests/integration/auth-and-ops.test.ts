import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, TEST_SECRET } from '../helpers/testkit.js';
import { startIntegration, type Integration } from '../helpers/integration.js';

let it$: Integration;
beforeAll(async () => {
  it$ = await startIntegration();
});
afterAll(() => it$.close());

describe('versioned operational endpoints', () => {
  it('/api/v1/healthz is OK and never touches dependencies', async () => {
    it$.fakes.kube.failOnce('ping', new Error('would fail'));
    const res = await request(it$.app).get('/api/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(it$.fakes.kube.calls).not.toContain('ping');
    await expect(it$.fakes.kube.ping()).rejects.toThrow('would fail'); // consume the armed failure
  });

  it('/api/v1/readyz reports ready when kubernetes and postgres answer', async () => {
    const res = await request(it$.app).get('/api/v1/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { kubernetes: 'ok', postgres: 'ok' } });
  });

  it('/api/v1/readyz reports 503 when the cluster is unreachable', async () => {
    it$.fakes.kube.failOnce('ping', new Error('connection refused'));
    const res = await request(it$.app).get('/api/v1/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not-ready', checks: { kubernetes: 'unavailable', postgres: 'ok' } });
  });

  it('unversioned probes are removed', async () => {
    expect((await request(it$.app).get('/healthz')).status).toBe(404);
  });
});

describe('POST /api/v1/login', () => {
  it('issues a verifiable admin token for the right credentials', async () => {
    const res = await request(it$.app).post('/api/v1/login').send(ADMIN);
    expect(res.status).toBe(200);
    const claims = jwt.verify(res.body.token, TEST_SECRET) as jwt.JwtPayload;
    expect(claims).toMatchObject({ sub: ADMIN.username, role: 'admin' });
  });

  it.each([
    ['wrong password', { username: ADMIN.username, password: 'nope' }],
    ['wrong username', { username: 'nope', password: ADMIN.password }],
  ])('rejects %s with 401 and no token', async (_l, body) => {
    const res = await request(it$.app).post('/api/v1/login').send(body);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(res.body.token).toBeUndefined();
  });

  it('rejects a malformed body with 400', async () => {
    const res = await request(it$.app).post('/api/v1/login').send({ username: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await request(it$.app)
      .post('/api/v1/login')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('rejects an oversized body with 413', async () => {
    const res = await request(it$.app)
      .post('/api/v1/login')
      .send({ username: 'x'.repeat(400_000), password: 'y' });
    expect(res.status).toBe(413);
  });
});

describe('authentication on protected routes', () => {
  it.each(['/api/v1/catalog', '/api/v1/pp1/workspaces', '/api/v1/pp1/projects'])(
    '%s needs a token',
    async (path) => {
      const res = await request(it$.app).get(path);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    },
  );

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign({ role: 'admin' }, 'some-other-secret-some-other-secret', {
      subject: 'attacker',
    });
    const res = await request(it$.app).get('/api/v1/pp1/workspaces').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('lets a non-admin user in only for their own soeid', async () => {
    const own = jwt.sign({ role: 'user' }, TEST_SECRET, { subject: 'pp1' });
    const ok = await request(it$.app).get('/api/v1/pp1/workspaces').set('Authorization', `Bearer ${own}`);
    expect(ok.status).toBe(200);
    const other = await request(it$.app).get('/api/v1/pp2/workspaces').set('Authorization', `Bearer ${own}`);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('FORBIDDEN');
  });

  it.each(['..%2Fetc', 'a%20b', 'x'])('rejects a malformed or too-short soeid (%s)', async (soeid) => {
    const res = await it$.api('get', `/api/v1/${soeid}/workspaces`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOEID');
  });
});

describe('versioning', () => {
  it('serves v1 without deprecation headers', async () => {
    const res = await it$.api('get', '/api/v1/pp1/workspaces');
    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBeUndefined();
  });

  it('rejects unversioned user paths', async () => {
    expect((await it$.api('get', '/pp1/workspaces')).status).toBe(404);
  });

  it('rejects unversioned login', async () => {
    expect((await request(it$.app).post('/login').send(ADMIN)).status).toBe(404);
  });

  it('an unknown API version is a 404, not a user lookup', async () => {
    const res = await it$.api('get', '/api/v2/pp1/workspaces');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROUTE_NOT_FOUND');
  });

  it('unknown routes under v1 are 404', async () => {
    const res = await it$.api('get', '/api/v1/pp1/nothing-here');
    expect(res.status).toBe(404);
  });
});

describe('request ids', () => {
  it('echoes a safe incoming x-request-id and generates one otherwise', async () => {
    const given = await request(it$.app).get('/api/v1/healthz').set('x-request-id', 'abc-12345678');
    expect(given.headers['x-request-id']).toBe('abc-12345678');
    const generated = await request(it$.app).get('/api/v1/healthz').set('x-request-id', 'bad id with spaces');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not advertise the framework', async () => {
    expect((await request(it$.app).get('/api/v1/healthz')).headers['x-powered-by']).toBeUndefined();
  });
});
