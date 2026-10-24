import type { AppConfig } from '../config/env.js';
import type { KubeObject } from '../types.js';
import type { KubeGateway } from '../infra/ports.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import type { MetricsRecorder } from './MetricsRecorder.js';
import type { NamespaceService } from './NamespaceService.js';

export const PAT_SECRET_PREFIX = 'git-credentials-secret-';
const CREDENTIALS_KEY = 'credentials';
const GIT_CREDENTIAL_SELECTOR = 'controller.devfile.io/git-credential=true';
const GITHUB_PAT_RE = /^ghp_[A-Za-z0-9]{36}$/;

export interface PatSummary {
  namespace: string;
  name: string;
  createdOn: string;
  lastTransitionTime: string;
}

export interface PatDetails extends PatSummary {
  token: string;
  scmUrl: string;
}

/** `ghp_ab…xyz`; the full value is never returned or logged. */
export function maskToken(token: string): string {
  return token.length > 5 ? `${token.slice(0, 2)}…${token.slice(-3)}` : '***';
}

export function assertValidGithubToken(token: string): void {
  if (!GITHUB_PAT_RE.test(token)) {
    throw new BadRequestError(
      "Invalid GitHub PAT format: token must start with 'ghp_' and be 40 characters long",
      'INVALID_PAT',
    );
  }
}

const iso = (value: Date | string | undefined): string => (value ? new Date(value).toISOString() : '');

export class PatService {
  constructor(
    private readonly kube: KubeGateway,
    private readonly namespaces: NamespaceService,
    private readonly recorder: MetricsRecorder,
    private readonly github: AppConfig['github'],
  ) {}

  async list(soeid: string): Promise<PatSummary[]> {
    const namespaces = await this.namespaces.listForUser(soeid);
    const result: PatSummary[] = [];
    for (const ns of namespaces) {
      const namespace = ns.metadata?.name ?? '';
      const secrets = await this.kube.list<KubeObject>('Secret', namespace, GIT_CREDENTIAL_SELECTOR);
      for (const secret of secrets) {
        const name = secret.metadata?.name ?? '';
        if (name.startsWith(PAT_SECRET_PREFIX)) result.push(this.summary(namespace, secret));
      }
    }
    return result;
  }

  async view(soeid: string, csiid: string, tokenName: string): Promise<PatDetails> {
    const namespace = await this.namespaces.require(soeid, csiid);
    const secret = await this.kube.get<KubeObject>('Secret', namespace, this.secretName(tokenName));
    if (!secret) throw new NotFoundError(`PAT '${tokenName}' not found`, 'PAT_NOT_FOUND');
    const encoded = (secret.data as Record<string, string> | undefined)?.[CREDENTIALS_KEY] ?? '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const token = /:([^:@]+)@[^@]+$/.exec(decoded)?.[1] ?? '';
    return {
      ...this.summary(namespace, secret),
      token: token ? maskToken(token) : '[unrecognized format]',
      scmUrl: secret.metadata?.annotations?.['che.eclipse.org/scm-url'] ?? this.github.url,
    };
  }

  async create(soeid: string, csiid: string, tokenName: string, token: string): Promise<PatSummary> {
    assertValidGithubToken(token);
    const namespace = await this.namespaces.require(soeid, csiid);
    const name = this.secretName(tokenName);
    if (await this.kube.get('Secret', namespace, name)) {
      throw new ConflictError(`PAT '${tokenName}' already exists`, 'PAT_EXISTS');
    }
    const created = await this.recorder.track(
      { soeid, csiid, eventtype: 'create', resourcetype: 'pat', resourcename: name },
      () => this.kube.create<KubeObject>('Secret', namespace, this.secretBody(soeid, namespace, name, token)),
    );
    return this.summary(namespace, created);
  }

  async update(soeid: string, csiid: string, tokenName: string, token: string): Promise<PatSummary> {
    assertValidGithubToken(token);
    const namespace = await this.namespaces.require(soeid, csiid);
    const name = this.secretName(tokenName);
    if (!(await this.kube.get('Secret', namespace, name))) {
      throw new NotFoundError(`PAT '${tokenName}' not found`, 'PAT_NOT_FOUND');
    }
    const updated = await this.recorder.track(
      { soeid, csiid, eventtype: 'update', resourcetype: 'pat', resourcename: name },
      () => this.kube.apply<KubeObject>('Secret', namespace, this.secretBody(soeid, namespace, name, token)),
    );
    return this.summary(namespace, updated);
  }

  /** Deleting a token that is already gone is a success (returns false). */
  async delete(soeid: string, csiid: string, tokenName: string): Promise<boolean> {
    const namespace = await this.namespaces.require(soeid, csiid);
    const name = this.secretName(tokenName);
    return this.recorder.track(
      { soeid, csiid, eventtype: 'delete', resourcetype: 'pat', resourcename: name },
      () => this.kube.delete('Secret', namespace, name),
    );
  }

  private secretName(tokenName: string): string {
    return `${PAT_SECRET_PREFIX}${tokenName}`;
  }

  private summary(namespace: string, secret: KubeObject): PatSummary {
    const name = secret.metadata?.name ?? '';
    const createdOn = iso(secret.metadata?.creationTimestamp);
    return {
      namespace,
      name: name.startsWith(PAT_SECRET_PREFIX) ? name.slice(PAT_SECRET_PREFIX.length) : name,
      createdOn,
      lastTransitionTime: secret.metadata?.annotations?.lastTransitionTime ?? createdOn,
    };
  }

  private secretBody(soeid: string, namespace: string, name: string, token: string): KubeObject {
    const scm = new URL(this.github.url);
    const user = encodeURIComponent(`${soeid}${this.github.userSuffix}`);
    const credentials = `${scm.protocol}//${user}:${token}@${scm.host}`;
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/component': 'workspace-secret',
          'app.kubernetes.io/part-of': 'che.eclipse.org',
          'controller.devfile.io/git-credential': 'true',
          'controller.devfile.io/watch-secret': 'true',
        },
        annotations: {
          'che.eclipse.org/automount-workspace-secret': 'true',
          'che.eclipse.org/git-credential': 'true',
          'che.eclipse.org/mount-as': 'file',
          'che.eclipse.org/mount-path': '/.git-credentials',
          'che.eclipse.org/scm-url': this.github.url,
          'controller.devfile.io/mount-path': '/.git-credentials',
          lastTransitionTime: new Date().toISOString(),
        },
      },
      type: 'Opaque',
      data: { [CREDENTIALS_KEY]: Buffer.from(credentials).toString('base64') },
    };
  }
}
