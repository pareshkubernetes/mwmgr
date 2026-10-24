import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConnectionOptions } from 'node:tls';
import type { AppConfig } from '../../config/env.js';

type PgConfig = AppConfig['postgres'];

/** CA bundle names by environment. */
const CERT_FILES: Record<string, string> = {
  development: 'dev.pem',
  uat: 'uat.pem',
  production: 'prod.pem',
};

/** Default certificate directory in the container. */
const CONTAINER_CERT_DIR = '/app/backend/cert';

/**
 * Which CA bundle to trust: an explicit POSTGRES_CA_FILE, else `<certDir>/<dev|uat|prod>.pem` chosen by NODE_ENV
 * (unknown environments fall back to dev.pem). `certDir` defaults to `./certs` in development and
 * `/app/backend/cert` otherwise.
 */
export function resolveCaPath(
  config: Pick<PgConfig, 'env' | 'caFile' | 'certDir'>,
  cwd = process.cwd(),
): string {
  if (config.caFile) return config.caFile;
  const file = CERT_FILES[config.env] ?? 'dev.pem';
  const dir =
    config.certDir ?? (config.env === 'development' ? path.resolve(cwd, 'certs') : CONTAINER_CERT_DIR);
  return path.join(dir, file);
}

/**
 * TLS options for the existing Postgres server. The server certificate is always verified against the CA;
 * only in `development` is the hostname check skipped (the dev instance is reached through a different name).
 */
export function buildSslOptions(
  config: Pick<PgConfig, 'ssl' | 'env' | 'caFile' | 'certDir'>,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): false | ConnectionOptions {
  if (!config.ssl) return false;
  const caPath = resolveCaPath(config);
  let ca: string;
  try {
    ca = readFile(caPath);
  } catch (error) {
    throw new Error(
      `Cannot read the Postgres CA certificate at ${caPath} (NODE_ENV=${config.env}): ${(error as Error).message}. ` +
        'Put the CA there, or set POSTGRES_CA_FILE / POSTGRES_CERT_DIR.',
      { cause: error },
    );
  }
  return config.env === 'development'
    ? { rejectUnauthorized: true, checkServerIdentity: () => undefined, ca }
    : { rejectUnauthorized: true, ca };
}
