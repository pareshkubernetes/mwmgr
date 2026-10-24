import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SAMPLE_DEVFILE_YAML } from './sample-devfile.js';

export interface RegistryServer {
  url: string;
  requests: string[];
  failing: boolean;
  close(): Promise<void>;
}

const CATALOG = [
  {
    name: 'java-maven',
    displayName: 'Java Maven',
    description: 'Java 17 with Maven',
    versions: [{ version: '1.0.0' }, { version: '2.0.0', default: true }],
  },
  { name: 'python', displayName: 'Python', versions: [{ version: '1.0.0', default: true }] },
];

/** A real HTTP server speaking the two devfile-registry endpoints workspace-mgr uses. */
export async function startRegistryServer(devfileYaml = SAMPLE_DEVFILE_YAML): Promise<RegistryServer> {
  const state: RegistryServer = { url: '', requests: [], failing: false, close: async () => undefined };
  const server = http.createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    if (state.failing) {
      res.writeHead(503).end('registry unavailable');
      return;
    }
    if (req.url === '/v2index/all') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(CATALOG));
      return;
    }
    const match = /^\/devfiles\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
    const entry = match && CATALOG.find((c) => c.name === decodeURIComponent(match[1] ?? ''));
    if (entry && entry.versions.some((v) => v.version === decodeURIComponent(match?.[2] ?? ''))) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(devfileYaml);
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return state;
}
