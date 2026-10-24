import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from './container.js';
import baseRouter from './routers/index.js';
import { createErrorHandler, notFoundHandler } from './http/errors.js';

export const API_PREFIX = '/api/v1';

export function createApp(c: Container): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(function requestContext(req, res, next) {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = Date.now();
    res.on('finish', function logRequest() {
      // Match request severity to the HTTP status.
      const outcome = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'success';
      c.logger[outcome]('request', {
        method: req.method,
        // Preserve the full path when logging requests handled by nested routers.
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Date.now() - started,
        requestId,
        soeid: res.locals.soeid as string | undefined,
      });
    });
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  const api = baseRouter(c);
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(c.logger));
  return app;
}
