import { randomBytes } from 'node:crypto';
import { BadRequestError } from './errors.js';

const SOEID_RE = /^[a-z0-9]{3,20}$/;
const CSIID_RE = /^\d{1,10}$/;
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const TOKEN_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;

/** Reserve API path names to avoid ambiguous user URLs. */
const RESERVED_SOEIDS = new Set(['api', 'login', 'catalog', 'healthz', 'readyz']);

/** Validate and normalise a user id. User ids end up in namespace names, so they are strictly allow-listed. */
export function parseSoeid(value: string): string {
  const soeid = value.trim().toLowerCase();
  if (!SOEID_RE.test(soeid) || RESERVED_SOEIDS.has(soeid)) {
    throw new BadRequestError('Invalid soeid', 'INVALID_SOEID');
  }
  return soeid;
}

export function parseCsiid(value: string): string {
  const csiid = value.trim();
  if (!CSIID_RE.test(csiid)) throw new BadRequestError('csiid must be numeric', 'INVALID_CSIID');
  return csiid;
}

export function parseResourceName(value: string, what = 'resource name'): string {
  const name = value.trim().toLowerCase();
  if (!DNS_LABEL_RE.test(name)) throw new BadRequestError(`Invalid ${what}`, 'INVALID_NAME');
  return name;
}

export function parseTokenName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!TOKEN_NAME_RE.test(name)) throw new BadRequestError('Invalid token name', 'INVALID_TOKEN_NAME');
  return name;
}

export const workspaceNamespace = (soeid: string, csiid: string): string => `${soeid}-devspaces-${csiid}`;
export const deploymentNamespace = (soeid: string, csiid: string): string =>
  `${soeid}-devspaces-deploy-${csiid}`;

export function csiidFromWorkspaceNamespace(namespace: string): string | undefined {
  return /-devspaces-(\d+)$/.exec(namespace)?.[1];
}

export function csiidFromDeploymentNamespace(namespace: string): string | undefined {
  return /-devspaces-deploy-(\d+)$/.exec(namespace)?.[1];
}

/** `https://api.<cluster>.ecs.dyn…:6443` → `<cluster>`. */
export function extractClusterName(url: string | undefined): string {
  const match = /(?:api\.|apps\.)([^.]+)\.ecs/.exec(url ?? '');
  return match?.[1] ?? 'unknown-cluster';
}

export const randomSuffix = (): string => randomBytes(2).toString('hex');

/** DNS-1123 workspace name `<stack>-<suffix>`, at most 63 characters. */
export function cleanWorkspaceName(base: string, suffix: string = randomSuffix()): string {
  const cleaned =
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63 - suffix.length - 1)
      .replace(/-+$/g, '') || 'workspace';
  return `${cleaned}-${suffix}`;
}
