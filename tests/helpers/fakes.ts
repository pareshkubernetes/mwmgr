import type { CatalogEntry, MetricsRecord } from '../../src/types.js';
import type {
  Clock,
  DevfileRegistry,
  MetricsStore,
  NamespaceCreatedEmail,
  NamespaceExistsEmail,
  NamespacesDeletedEmail,
  Notifier,
} from '../../src/infra/ports.js';
import { WorkspaceConfigNotFoundError } from '../../src/utils/errors.js';
import { SAMPLE_DEVFILE_YAML } from './sample-devfile.js';

export class FakeMetricsStore implements MetricsStore {
  readonly records: MetricsRecord[] = [];
  failWith?: Error;
  delayMs = 0;
  closed = false;

  async insert(record: MetricsRecord): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    this.records.push(record);
  }
  async ping(): Promise<void> {
    if (this.failWith) throw this.failWith;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeNotifier implements Notifier {
  readonly created: NamespaceCreatedEmail[] = [];
  readonly existing: NamespaceExistsEmail[] = [];
  readonly deleted: NamespacesDeletedEmail[] = [];
  async namespaceCreated(e: NamespaceCreatedEmail): Promise<void> {
    this.created.push(e);
  }
  async namespaceAlreadyExists(e: NamespaceExistsEmail): Promise<void> {
    this.existing.push(e);
  }
  async namespacesDeleted(e: NamespacesDeletedEmail): Promise<void> {
    this.deleted.push(e);
  }
}

export class FakeRegistry implements DevfileRegistry {
  catalog: CatalogEntry[] = [
    {
      name: 'java-maven',
      displayName: 'Java Maven',
      description: 'Java 17 with Maven',
      versions: [{ version: '1.0.0' }, { version: '2.0.0', default: true }],
    },
    { name: 'python', displayName: 'Python', versions: [{ version: '1.0.0', default: true }] },
  ];
  yaml = SAMPLE_DEVFILE_YAML;
  failCatalog?: Error;

  async getCatalog(): Promise<CatalogEntry[]> {
    if (this.failCatalog) throw this.failCatalog;
    return this.catalog;
  }

  async getDevfile(stack: string, version?: string): Promise<{ yaml: string; version: string }> {
    const entry = (await this.getCatalog()).find((e) => e.name === stack);
    if (!entry) throw new WorkspaceConfigNotFoundError(`No such workspace config: ${stack}`);
    const versions = entry.versions ?? [];
    const chosen = version
      ? versions.find((v) => v.version === version)
      : (versions.find((v) => v.default) ?? versions[0]);
    if (!chosen) throw new WorkspaceConfigNotFoundError(`No version '${version}' for ${stack}`);
    return { yaml: this.yaml, version: chosen.version };
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date = new Date('2026-01-15T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
}
