import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import {
  DevfileRegistryClient,
  createRegistryHttp,
} from '../../../src/infra/devreg/DevfileRegistryClient.js';
import { UpstreamError, WorkspaceConfigNotFoundError } from '../../../src/utils/errors.js';

type Handler = (url: string, config: InternalAxiosRequestConfig) => { status: number; data: unknown };

function http(handler: Handler): { http: AxiosInstance; urls: string[] } {
  const urls: string[] = [];
  const instance = axios.create({
    baseURL: 'http://registry.test',
    validateStatus: (s) => s >= 200 && s < 300,
    adapter: async (config) => {
      const url = config.url ?? '';
      urls.push(url);
      const { status, data } = handler(url, config as InternalAxiosRequestConfig);
      const response = {
        data,
        status,
        statusText: String(status),
        headers: {},
        config: config as InternalAxiosRequestConfig,
      };
      if (status >= 400)
        throw new AxiosError(
          `status ${status}`,
          'ERR_BAD_RESPONSE',
          config as InternalAxiosRequestConfig,
          {},
          response,
        );
      return response;
    },
  });
  return { http: instance, urls };
}

const catalog = [
  { name: 'java', versions: [{ version: '1.0.0' }, { version: '2.0.0', default: true }] },
  { name: 'py', versions: [{ version: '3.1.0' }] },
  { name: 'empty', versions: [] },
];

const registry = (devfile = 'schemaVersion: 2.2.0') =>
  http((url) => (url === 'v2index/all' ? { status: 200, data: catalog } : { status: 200, data: devfile }));

describe('getCatalog', () => {
  it('returns the registry index', async () => {
    expect(await new DevfileRegistryClient(registry().http).getCatalog()).toEqual(catalog);
  });
  it('wraps failures as UpstreamError', async () => {
    const client = new DevfileRegistryClient(http(() => ({ status: 503, data: '' })).http);
    await expect(client.getCatalog()).rejects.toBeInstanceOf(UpstreamError);
  });
  it('rejects a non-list index', async () => {
    const client = new DevfileRegistryClient(http(() => ({ status: 200, data: { not: 'a list' } })).http);
    await expect(client.getCatalog()).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('getDevfile', () => {
  it('picks the default version and fetches that devfile', async () => {
    const { http: h, urls } = registry('yaml-body');
    expect(await new DevfileRegistryClient(h).getDevfile('java')).toEqual({
      yaml: 'yaml-body',
      version: '2.0.0',
    });
    expect(urls).toEqual(['v2index/all', 'devfiles/java/2.0.0']);
  });
  it('honours a requested version', async () => {
    const { http: h, urls } = registry();
    expect((await new DevfileRegistryClient(h).getDevfile('java', '1.0.0')).version).toBe('1.0.0');
    expect(urls.at(-1)).toBe('devfiles/java/1.0.0');
  });
  it('falls back to the first version when none is marked default', async () => {
    expect((await new DevfileRegistryClient(registry().http).getDevfile('py')).version).toBe('3.1.0');
  });
  it('404s for an unknown stack, unknown version, or versionless stack', async () => {
    const client = new DevfileRegistryClient(registry().http);
    await expect(client.getDevfile('cobol')).rejects.toBeInstanceOf(WorkspaceConfigNotFoundError);
    await expect(client.getDevfile('java', '9.9.9')).rejects.toBeInstanceOf(WorkspaceConfigNotFoundError);
    await expect(client.getDevfile('empty')).rejects.toBeInstanceOf(WorkspaceConfigNotFoundError);
  });
  it('URL-encodes stack and version', async () => {
    const { http: h, urls } = http((url) =>
      url === 'v2index/all'
        ? { status: 200, data: [{ name: 'a/b', versions: [{ version: '1 0' }] }] }
        : { status: 200, data: 'y' },
    );
    await new DevfileRegistryClient(h).getDevfile('a/b');
    expect(urls.at(-1)).toBe('devfiles/a%2Fb/1%200');
  });
  it('wraps a failing devfile download as UpstreamError', async () => {
    const h = http((url) =>
      url === 'v2index/all' ? { status: 200, data: catalog } : { status: 500, data: '' },
    ).http;
    await expect(new DevfileRegistryClient(h).getDevfile('java')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('createRegistryHttp', () => {
  it('sets base URL and a timeout', () => {
    const h = createRegistryHttp('http://x');
    expect(h.defaults.baseURL).toBe('http://x');
    expect(h.defaults.timeout).toBe(10_000);
  });
});
