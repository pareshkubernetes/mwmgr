export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message, 400, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options?: { cause?: unknown }) {
    super(message, 403, 'FORBIDDEN', options);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND', options?: { cause?: unknown }) {
    super(message, 404, code, options);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', options?: { cause?: unknown }) {
    super(message, 409, code, options);
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 502, 'UPSTREAM_ERROR', options);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string) {
    super(message, 504, 'TIMEOUT');
  }
}

export class WorkspaceConfigNotFoundError extends NotFoundError {
  constructor(message: string) {
    super(message, 'WORKSPACE_CONFIG_NOT_FOUND');
  }
}

export class WorkspaceCountExceededError extends ConflictError {
  constructor(message: string) {
    super(message, 'WORKSPACE_COUNT_EXCEEDED');
  }
}

export class WorkspaceRunCountExceededError extends ConflictError {
  constructor(message: string) {
    super(message, 'WORKSPACE_RUN_COUNT_EXCEEDED');
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
