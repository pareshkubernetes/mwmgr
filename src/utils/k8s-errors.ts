import axios from 'axios';
import { AppError, ConflictError, ForbiddenError, NotFoundError, UpstreamError } from './errors.js';

interface KubeErrorLike {
  code?: unknown;
  statusCode?: unknown;
  body?: unknown;
  response?: { status?: unknown };
  message?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseBody(body: unknown): { code?: number; message?: string } {
  if (typeof body === 'string') {
    try {
      return parseBody(JSON.parse(body));
    } catch {
      return { message: body };
    }
  }
  if (body && typeof body === 'object') {
    const b = body as { code?: unknown; message?: unknown };
    return { code: asNumber(b.code), message: typeof b.message === 'string' ? b.message : undefined };
  }
  return {};
}

/** HTTP status carried by a Kubernetes client / axios error, if any. */
export function k8sStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as KubeErrorLike;
  return asNumber(e.code) ?? asNumber(e.statusCode) ?? asNumber(e.response?.status) ?? parseBody(e.body).code;
}

export const isK8sStatus = (error: unknown, status: number): boolean => k8sStatus(error) === status;

/** Human readable message for an unknown failure. Never includes upstream response bodies verbatim for 5xx. */
export function describeError(context: string, error: unknown): string {
  const status = k8sStatus(error);
  const kubeMessage = parseBody((error as KubeErrorLike | undefined)?.body).message;

  if (status === 404) return `${context}: Resource not found (404)`;
  if (status !== undefined && !axios.isAxiosError(error)) {
    return `${context}: Kubernetes API error (${status}) ${kubeMessage ?? (error as Error)?.message ?? ''}`.trim();
  }
  if (axios.isAxiosError(error)) {
    if (error.response) return `${context}: HTTP ${error.response.status} ${error.message}`;
    if (error.request) return `${context}: No response received from server`;
    return `${context}: Axios error ${error.message}`;
  }
  if (error instanceof Error) {
    if (error.message.includes('certificate') || error.message.includes('SSL')) {
      return `${context}: TLS/SSL certificate error`;
    }
    return `${context}: ${error.message}`;
  }
  return `${context}: ${String(error)}`;
}

/** Translate whatever a Kubernetes call threw into an AppError. */
export function toAppError(context: string, error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = k8sStatus(error);
  const message = describeError(context, error);
  if (status === 404) return new NotFoundError(message, 'NOT_FOUND', { cause: error });
  if (status === 403) {
    return new ForbiddenError(`${context}: Permission denied, insufficient privileges`, { cause: error });
  }
  if (status === 409) return new ConflictError(message, 'CONFLICT', { cause: error });
  return new UpstreamError(message, { cause: error });
}
