import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, NotFoundError, errorMessage } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

export interface ErrorBody {
  error: string;
  message: string;
  code: string;
}

export const errorBody = (message: string, code: string): ErrorBody => ({ error: message, message, code });

/** Express 4 does not catch rejected promises; this forwards them to the error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export const notFoundHandler: RequestHandler = function routeNotFound(req, _res, next) {
  next(new NotFoundError(`Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND'));
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return function handleRequestError(err: unknown, req, res, next) {
    if (res.headersSent) return next(err);
    const requestId = res.locals.requestId as string | undefined;

    if (err instanceof AppError) {
      logger[err.status >= 500 ? 'error' : 'warn']('request.failed', {
        requestId,
        method: req.method,
        path: req.originalUrl?.split('?')[0] ?? req.path,
        status: err.status,
        code: err.code,
        error: err,
      });
      res.status(err.status).json(errorBody(err.message, err.code));
      return;
    }
    // body-parser errors carry a status and a type
    const parserError = err as { status?: number; type?: string };
    if (parserError.type === 'entity.parse.failed') {
      logger.warn('request.failed', {
        requestId,
        method: req.method,
        path: req.path,
        status: 400,
        code: 'INVALID_JSON',
        error: 'Request body is not valid JSON',
      });
      res.status(400).json(errorBody('Request body is not valid JSON', 'INVALID_JSON'));
      return;
    }
    if (parserError.type === 'entity.too.large') {
      logger.warn('request.failed', {
        requestId,
        method: req.method,
        path: req.path,
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        error: 'Request body is too large',
      });
      res.status(413).json(errorBody('Request body is too large', 'PAYLOAD_TOO_LARGE'));
      return;
    }
    // Never leak internals for unexpected errors.
    logger.error('request.crashed', {
      requestId,
      path: req.path,
      error: err instanceof Error ? err : errorMessage(err),
    });
    res.status(500).json(errorBody('Internal server error', 'INTERNAL_ERROR'));
  };
}
