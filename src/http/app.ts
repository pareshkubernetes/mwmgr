import { randomUUID } from 'node:crypto';
import express, { Router, type Express, type Request, type RequestHandler, type Response } from 'express';
import type { Container } from '../container.js';
import { parseCsiid, parseTokenName } from '../utils/names.js';
import { UnauthorizedError } from '../utils/errors.js';
import { authenticate, authorizeSoeid, checkAdminCredentials, getSoeid, signToken } from './auth.js';
import { asyncHandler, createErrorHandler, errorBody, notFoundHandler } from './errors.js';
import {
  createWorkspaceSchema,
  csiidBodySchema,
  csiidQuerySchema,
  gitConfigBodySchema,
  loginSchema,
  parse,
  patBodySchema,
} from './schemas.js';

export const API_PREFIX = '/api/v1';

const param = (req: Request, name: string): string => req.params[name] ?? '';

/** RFC 8594-style signalling that an unversioned path is going away. */
const deprecatedAlias: RequestHandler = (req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', `<${API_PREFIX}${req.path}>; rel="successor-version"`);
  next();
};

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = Date.now();
    res.on('finish', () =>
      c.logger.info('request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        soeid: res.locals.soeid as string | undefined,
      }),
    );
    next();
  });

  // ---- operations ---------------------------------------------------------------------------
  app.get('/healthz', (_req, res) => {
    res.send('OK');
  });

  app.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      const checks: Record<string, string> = {};
      await Promise.all([
        c.kube.ping().then(
          () => (checks.kubernetes = 'ok'),
          () => (checks.kubernetes = 'unavailable'),
        ),
        c.metrics.ping().then(
          () => (checks.postgres = 'ok'),
          () => (checks.postgres = 'unavailable'),
        ),
      ]);
      const ready = Object.values(checks).every((v) => v === 'ok');
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
    }),
  );

  // ---- versioned API (mounted at /api/v1, and optionally at / as a deprecated alias) --------
  const api = Router();

  api.post('/login', (req, res, next) => {
    try {
      const { username, password } = parse(loginSchema, req.body);
      if (!checkAdminCredentials(c.config.auth, username, password)) {
        throw new UnauthorizedError('Username or password is incorrect');
      }
      res.json({ token: signToken(c.config.auth, { soeid: username, role: 'admin' }) });
    } catch (error) {
      next(error);
    }
  });

  const auth = authenticate(c.config.auth);

  api.get(
    '/catalog',
    auth,
    asyncHandler(async (_req, res) => {
      res.json(await c.registry.getCatalog());
    }),
  );

  // ---- per-user routes ----------------------------------------------------------------------
  const user = Router({ mergeParams: true });

  user.get(
    '/projects',
    asyncHandler(async (_req, res) => {
      res.json(await c.namespaces.listProjects(getSoeid(res)));
    }),
  );

  user.get(
    '/workspaces',
    asyncHandler(async (_req, res) => {
      res.json(await c.workspaces.list(getSoeid(res)));
    }),
  );

  user.get(
    '/workspaces/:id',
    asyncHandler(async (req, res) => {
      res.json(await c.workspaces.get(getSoeid(res), param(req, 'id')));
    }),
  );

  user.post(
    '/workspaces',
    asyncHandler(async (req, res) => {
      const body = parse(createWorkspaceSchema, req.body);
      const workspace = await c.workspaces.create({
        soeid: getSoeid(res),
        csiid: parseCsiid(body.csiid),
        devworkspaceValue: body.devworkspaceValue,
        editor: body.editor,
        stackVersion: body.stackVersion,
        repositoryUrl: body.repositoryUrl,
        repositoryBranch: body.repositoryBranch,
      });
      res.status(200).json(workspace);
    }),
  );

  user.delete(
    '/workspaces/:id',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id');
      await c.workspaces.delete(getSoeid(res), id);
      res.json({ message: `Workspace with id ${id} is terminating.` });
    }),
  );

  user.post(
    '/workspaces/:id/start',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id');
      await c.workspaces.start(getSoeid(res), id);
      res.json({ message: `Workspace with id ${id} is starting.` });
    }),
  );

  user.post(
    '/workspaces/:id/stop',
    asyncHandler(async (req, res) => {
      const id = param(req, 'id');
      await c.workspaces.stop(getSoeid(res), id);
      res.json({ message: `Workspace with id ${id} is stopping.` });
    }),
  );

  // Personal access tokens
  user.get(
    '/pats',
    asyncHandler(async (_req, res) => {
      res.json(await c.pats.list(getSoeid(res)));
    }),
  );
  user.get(
    '/pats/:tokenName',
    asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidQuerySchema, req.query);
      res.json(await c.pats.view(getSoeid(res), parseCsiid(csiid), parseTokenName(param(req, 'tokenName'))));
    }),
  );
  user.post(
    '/pats/:tokenName',
    asyncHandler(async (req, res) => {
      const body = parse(patBodySchema, req.body);
      const created = await c.pats.create(
        getSoeid(res),
        parseCsiid(body.csiid),
        parseTokenName(param(req, 'tokenName')),
        body.token,
      );
      res.status(201).json(created);
    }),
  );
  user.put(
    '/pats/:tokenName',
    asyncHandler(async (req, res) => {
      const body = parse(patBodySchema, req.body);
      res.json(
        await c.pats.update(
          getSoeid(res),
          parseCsiid(body.csiid),
          parseTokenName(param(req, 'tokenName')),
          body.token,
        ),
      );
    }),
  );
  user.delete(
    '/pats/:tokenName',
    asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidQuerySchema, req.query);
      const tokenName = parseTokenName(param(req, 'tokenName'));
      const removed = await c.pats.delete(getSoeid(res), parseCsiid(csiid), tokenName);
      res.json({
        message: removed ? `PAT '${tokenName}' deleted.` : `PAT '${tokenName}' not found; nothing to delete.`,
      });
    }),
  );

  // Git config
  user.get(
    '/gitconfig',
    asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidQuerySchema, req.query);
      res.json(await c.gitConfig.view(getSoeid(res), parseCsiid(csiid)));
    }),
  );
  user.put(
    '/gitconfig',
    asyncHandler(async (req, res) => {
      const body = parse(gitConfigBodySchema, req.body);
      res.json(await c.gitConfig.upsert(getSoeid(res), parseCsiid(body.csiid), body.content));
    }),
  );
  user.delete(
    '/gitconfig',
    asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidQuerySchema, req.query);
      const removed = await c.gitConfig.delete(getSoeid(res), parseCsiid(csiid));
      res.json({ message: removed ? 'Git config deleted.' : 'Git config not found; nothing to delete.' });
    }),
  );

  // Deployment (build/deploy) projects
  user.get(
    '/deployment-projects',
    asyncHandler(async (_req, res) => {
      res.json(await c.deployments.list(getSoeid(res)));
    }),
  );
  user.post(
    '/deployment-projects',
    asyncHandler(async (req, res) => {
      const { csiid } = parse(csiidBodySchema, req.body);
      const result = await c.deployments.ensure(getSoeid(res), parseCsiid(csiid));
      res.status(result.exists ? 200 : 201).json(result);
    }),
  );
  user.delete(
    '/deployment-projects',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await c.deployments.delete(getSoeid(res)));
    }),
  );

  api.use('/:soeid', auth, authorizeSoeid(), user);

  app.use(API_PREFIX, api);
  if (c.config.legacyRoutes) {
    // Pre-versioning paths kept so existing Orion builds keep working while they migrate to /api/v1.
    const legacy = Router();
    // Unknown /api/... paths (e.g. a future /api/v2) must 404, not be read as `/:soeid` = "api".
    legacy.use((req, _res, next) =>
      req.path === '/api' || req.path.startsWith('/api/') ? next('router') : next(),
    );
    legacy.use(deprecatedAlias, api);
    app.use('/', legacy);
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(c.logger));
  return app;
}

export { errorBody };
