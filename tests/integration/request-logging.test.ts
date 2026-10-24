import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLORS, RESET } from '../../src/utils/log-format.js';
import { createLogger } from '../../src/utils/logger.js';
import { startIntegration, type Integration } from '../helpers/integration.js';

/** Terminal output exactly as an operator sees it: pretty format with colours. */
const raw: string[] = [];
let t: Integration;

beforeAll(async () => {
  const logger = createLogger('debug', (line) => raw.push(line), {}, { format: 'pretty', color: true });
  t = await startIntegration({}, { logger });
});
afterAll(() => t.close());
beforeEach(() => {
  raw.length = 0;
});

const findRequest = (path: string) => raw.find((l) => l.includes('| request ') && l.includes(path));
/** The line is written when the response has been sent, which can be a moment after the client has it. */
async function requestLine(path: string): Promise<string | undefined> {
  for (let i = 0; i < 50 && !findRequest(path); i++) await new Promise((r) => setTimeout(r, 10));
  return findRequest(path);
}
const strip = (line: string) =>
  line
    .replaceAll(COLORS.error, '')
    .replaceAll(COLORS.warn, '')
    .replaceAll(COLORS.success, '')
    .replaceAll(COLORS.info, '')
    .replaceAll(RESET, '');

describe('what the terminal shows for each API call', () => {
  it.each(['expired', 'signature', 'malformed'])(
    'logs %s JWT failures at authenticateRequest with a useful response',
    async (kind) => {
      const token =
        kind === 'expired'
          ? jwt.sign({}, t.container.config.auth.secretKey, { subject: 'pp1', expiresIn: -1 })
          : kind === 'signature'
            ? jwt.sign({}, 'different-signing-key', { subject: 'pp1' })
            : 'invalid-token';
      const response = await request(t.app)
        .post('/api/v1/pp1/workspaces')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(response.status).toBe(401);
      expect(response.body.message).toMatch(
        kind === 'signature' ? /signature verification failed/ : new RegExp(kind),
      );
      const failure = strip(raw.find((line) => line.includes('request.failed')) as string);
      expect(failure).toMatch(/\[auth\.ts:\d+\] \[authenticateRequest\]/);
      expect(failure).toContain(response.body.message);
      expect(failure).toContain('UNAUTHORIZED');
      expect(raw.join('\n')).not.toContain(token);
      expect(raw.join('\n')).not.toMatch(/anonymous|File:|Function:/);
      expect(t.fakes.kube.calls).not.toContain('createNamespace');
    },
  );
  it('logs schema failures at parse with their validation detail', async () => {
    const response = await t.api('post', '/api/v1/pp1/workspaces').send({ csiid: 'bad' });
    expect(response.status).toBe(400);
    const failure = strip(raw.find((line) => line.includes('request.failed')) as string);
    expect(failure).toMatch(/\[schemas\.ts:\d+\] \[parse\]/);
    expect(failure).toContain(response.body.message);
  });
  it('a successful call is green, with method, path, status and duration', async () => {
    await request(t.app).get('/api/v1/healthz');
    const line = await requestLine('/api/v1/healthz');
    expect(line?.startsWith(COLORS.success)).toBe(true);
    expect(strip(line as string)).toMatch(
      /\| OK {4}\| request +\| GET +\/api\/v1\/healthz -> 200 \(\d+ ms\) {2}requestId=[0-9a-f-]{36}$/,
    );
  });

  it('shows the FULL path, also for successful calls handled inside nested routers', async () => {
    t.fakes.kube.seedNamespace('pp1-devspaces-1001', 'pp1', '1001');
    await t.api('get', '/api/v1/pp1/projects?csiid=1001');
    await request(t.app)
      .post('/api/v1/login')
      .send({ username: 'orion-admin', password: 'correct horse battery staple' });
    expect(strip((await requestLine('/api/v1/pp1/projects')) as string)).toContain(
      'GET    /api/v1/pp1/projects -> 200',
    );
    expect(strip((await requestLine('/api/v1/login')) as string)).toContain('POST   /api/v1/login -> 200');
    // the query string is not part of the logged path
    expect(raw.join('\n')).not.toContain('csiid=1001 ->');
    expect(raw.join('\n')).not.toContain('?csiid');
  });

  it('a call rejected for the caller (401, 404, 409 ...) is orange', async () => {
    await request(t.app).get('/api/v1/pp1/workspaces'); // no token
    const line = await requestLine('/api/v1/pp1/workspaces');
    expect(line?.startsWith(COLORS.warn)).toBe(true);
    expect(strip(line as string)).toContain('| WARN  | request');
    expect(strip(line as string)).toContain('-> 401');
  });

  it('a call that fails on our side (5xx) is red, and the cause is logged in red too', async () => {
    t.fakes.kube.failOnce('listNamespaces', new Error('boom: the cluster exploded'));
    const res = await t.api('get', '/api/v1/pp1/workspaces');
    expect(res.status).toBe(500);

    const line = await requestLine('/api/v1/pp1/workspaces');
    expect(line?.startsWith(COLORS.error)).toBe(true);
    expect(strip(line as string)).toContain('| ERROR | request');
    expect(strip(line as string)).toContain('-> 500');

    const cause = raw.find((l) => l.includes('request.crashed'));
    expect(cause?.startsWith(COLORS.error)).toBe(true);
    expect(strip(cause as string)).toContain('error="boom: the cluster exploded"');
  });

  it('a user action that worked (create) is green: the call and the workspace event', async () => {
    const res = await t
      .api('post', '/api/v1/pp1/workspaces')
      .send({ devworkspaceValue: 'java-maven', csiid: '1001' });
    expect(res.status).toBe(200);
    expect((await requestLine('/api/v1/pp1/workspaces'))?.startsWith(COLORS.success)).toBe(true);
    const created = raw.find((l) => l.includes('workspace.created'));
    expect(created?.startsWith(COLORS.success)).toBe(true);
    expect(strip(created as string)).toMatch(
      /\| OK {4}\| workspace\.created +\| soeid=pp1 {2}namespace=pp1-devspaces-1001 {2}workspace=java-maven-[0-9a-f]{4}$/,
    );
  });

  it('start and stop are green successes too', async () => {
    const created = await t
      .api('post', '/api/v1/pp1/workspaces')
      .send({ devworkspaceValue: 'python', csiid: '1001' });
    const id = created.body.id as string;
    t.fakes.kube.setPhase('pp1-devspaces-1001', id, 'Running');
    raw.length = 0;
    await t.api('post', `/api/v1/pp1/workspaces/${id}/stop`);
    expect(raw.find((l) => l.includes('workspace.stopped'))?.startsWith(COLORS.success)).toBe(true);
    t.fakes.kube.setPhase('pp1-devspaces-1001', id, 'Stopped');
    await t.api('post', `/api/v1/pp1/workspaces/${id}/start`);
    expect(raw.find((l) => l.includes('workspace.started'))?.startsWith(COLORS.success)).toBe(true);
  });

  it('never prints a secret, and every entry stays readable text', async () => {
    const pat = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
    t.fakes.kube.seedNamespace('pp1-devspaces-1001', 'pp1', '1001');
    await t.api('post', '/api/v1/pp1/pats/main').send({ csiid: '1001', token: pat });
    expect(raw.join('\n')).not.toContain(pat);
    for (const line of raw) expect(line).not.toMatch(/\{"time"|\[object Object\]|undefined/);
  });
});
