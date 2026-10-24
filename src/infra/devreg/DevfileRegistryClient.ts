import axios, { type AxiosInstance } from 'axios';
import type { CatalogEntry } from '../../domain/types.js';
import { UpstreamError, WorkspaceConfigNotFoundError } from '../../utils/errors.js';
import { describeError } from '../../utils/k8s-errors.js';
import type { DevfileRegistry } from '../ports.js';

export function createRegistryHttp(baseURL: string): AxiosInstance {
  return axios.create({ baseURL, timeout: 10_000, headers: { Accept: 'application/json' } });
}

export class DevfileRegistryClient implements DevfileRegistry {
  constructor(private readonly http: AxiosInstance) {}

  async getCatalog(): Promise<CatalogEntry[]> {
    try {
      const res = await this.http.get<unknown>('v2index/all');
      if (!Array.isArray(res.data)) throw new Error('registry index is not a list');
      return res.data as CatalogEntry[];
    } catch (error) {
      throw new UpstreamError(describeError('Devfile registry catalog', error), { cause: error });
    }
  }

  async getDevfile(stack: string, version?: string): Promise<{ yaml: string; version: string }> {
    const catalog = await this.getCatalog();
    const entry = catalog.find((e) => e.name === stack);
    if (!entry) throw new WorkspaceConfigNotFoundError(`No such workspace config: ${stack}`);

    const versions = entry.versions ?? [];
    const chosen = version
      ? versions.find((v) => v.version === version)
      : (versions.find((v) => v.default) ?? versions[0]);
    if (!chosen) {
      throw new WorkspaceConfigNotFoundError(
        version ? `No version '${version}' for workspace config: ${stack}` : `No versions for ${stack}`,
      );
    }

    try {
      const res = await this.http.get<string>(
        `devfiles/${encodeURIComponent(stack)}/${encodeURIComponent(chosen.version)}`,
        { responseType: 'text', transformResponse: (d: unknown) => d, headers: { Accept: 'text/plain' } },
      );
      return { yaml: String(res.data), version: chosen.version };
    } catch (error) {
      throw new UpstreamError(describeError(`Devfile '${stack}'`, error), { cause: error });
    }
  }
}
