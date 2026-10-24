import { describe, expect, it } from 'vitest';
import { EmailNotifier, NoopNotifier, type FetchFn } from '../../../src/infra/email/EmailNotifier.js';
import {
  clusterLinks,
  deletedNamespacesEmailBody,
  escapeHtml,
  existingNamespaceEmailBody,
  newNamespaceEmailBody,
} from '../../../src/infra/email/email-templates.js';
import { GraphqlUserDirectory, NullUserDirectory } from '../../../src/infra/email/GraphqlUserDirectory.js';
import { createLogger } from '../../../src/utils/logger.js';

const config = {
  url: 'http://mail.test/',
  username: 'svc',
  password: 'pw',
  sender: 'noreply@example.com',
  cc: 'team@example.com',
  emailDomain: 'example.com',
};
const API = 'https://api.prod1.ecs.dyn.example.net:6443';

function setup(opts: { status?: number; fail?: boolean; name?: string; cfg?: Partial<typeof config> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (opts.fail) throw new Error('network down');
    return new Response('{}', { status: opts.status ?? 200 });
  };
  const directory = new (class {
    async firstName() {
      return opts.name;
    }
  })();
  const logger = createLogger('debug', (l) => logs.push(JSON.parse(l)));
  const notifier = new EmailNotifier({ ...config, ...opts.cfg }, API, directory, logger, fetchFn);
  const body = () => JSON.parse(String(calls[0]?.init.body)) as Record<string, string>;
  return { notifier, calls, logs, body };
}

describe('EmailNotifier', () => {
  it('posts a new-namespace email to the mail service with basic auth', async () => {
    const { notifier, calls, body } = setup({ name: 'Pat' });
    await notifier.namespaceCreated({ soeid: 'pp1', namespace: 'pp1-devspaces-deploy-1' });
    expect(calls[0]?.url).toBe('http://mail.test/send-mail/v2');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('svc:pw').toString('base64')}`,
    );
    expect(body()).toMatchObject({
      sender: 'noreply@example.com',
      receiver: 'pp1@example.com',
      receiverName: 'PP1',
      cc: 'team@example.com',
      subject: 'Success! Your DevSpaces Deployment Project is Ready!',
      isHtml: true,
    });
    expect(body().emailMessage).toContain('Dear Pat,');
    expect(body().emailMessage).toContain('pp1-devspaces-deploy-1');
    expect(body().emailMessage).toContain(
      'https://oauth-openshift.apps.prod1.ecs.dyn.example.net/oauth/token/request',
    );
  });

  it('greets by soeid when the directory does not know the person', async () => {
    const { notifier, body } = setup();
    await notifier.namespaceCreated({ soeid: 'pp1', namespace: 'n' });
    expect(body().emailMessage).toContain('Dear User PP1,');
  });

  it('sends the already-exists and deleted emails', async () => {
    const a = setup();
    await a.notifier.namespaceAlreadyExists({ soeid: 'pp1', newNamespace: 'new', existingNamespace: 'old' });
    expect(a.body().subject).toBe('Important: Your DevSpaces Deployment Project Already Exists');
    expect(a.body().emailMessage).toContain('oc project old');

    const d = setup();
    await d.notifier.namespacesDeleted({ soeid: 'pp1', namespaces: ['a', 'b'] });
    expect(d.body().subject).toBe('Confirmation: DevSpaces Deployment Project(s) Deleted');
    expect(d.body().emailMessage).toContain('<code>a</code>');
  });

  it('sends nothing for an empty deletion list', async () => {
    const { notifier, calls } = setup();
    await notifier.namespacesDeleted({ soeid: 'pp1', namespaces: [] });
    expect(calls).toHaveLength(0);
  });

  it('is disabled when no mail URL is configured', async () => {
    const { notifier, calls } = setup({ cfg: { url: undefined } as never });
    await notifier.namespaceCreated({ soeid: 'pp1', namespace: 'n' });
    expect(calls).toHaveLength(0);
  });

  it('never throws: logs a failed send and a non-2xx answer', async () => {
    const boom = setup({ fail: true });
    await expect(boom.notifier.namespaceCreated({ soeid: 'pp1', namespace: 'n' })).resolves.toBeUndefined();
    expect(boom.logs).toContainEqual(
      expect.objectContaining({ event: 'email.failed', error: 'network down' }),
    );

    const bad = setup({ status: 500 });
    await expect(bad.notifier.namespaceCreated({ soeid: 'pp1', namespace: 'n' })).resolves.toBeUndefined();
    expect(bad.logs).toContainEqual(expect.objectContaining({ event: 'email.failed' }));
  });

  it('never logs the mail credentials', async () => {
    const { notifier, logs } = setup({ fail: true });
    await notifier.namespaceCreated({ soeid: 'pp1', namespace: 'n' });
    expect(JSON.stringify(logs)).not.toContain('pw');
  });
});

describe('NoopNotifier', () => {
  it('does nothing', async () => {
    const n = new NoopNotifier();
    await expect(
      Promise.all([n.namespaceCreated(), n.namespaceAlreadyExists(), n.namespacesDeleted()]),
    ).resolves.toBeDefined();
  });
});

describe('templates', () => {
  it('escapes HTML in every interpolated value', () => {
    const evil = '<script>alert(1)</script>';
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    const cluster = clusterLinks(API);
    for (const html of [
      newNamespaceEmailBody({ firstName: evil, soeid: 'x', namespace: evil, cluster, recipient: evil }),
      existingNamespaceEmailBody({
        firstName: evil,
        soeid: 'x',
        newNamespace: evil,
        existingNamespace: evil,
        cluster,
        recipient: evil,
      }),
      deletedNamespacesEmailBody({ firstName: evil, soeid: 'x', namespaces: [evil], recipient: evil }),
    ]) {
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    }
  });

  it('derives console and token URLs from the API URL', () => {
    expect(clusterLinks(API)).toEqual({
      apiUrl: API,
      consoleUrl: 'https://console-openshift-console.apps.prod1.ecs.dyn.example.net/',
      tokenUrl: 'https://oauth-openshift.apps.prod1.ecs.dyn.example.net/oauth/token/request',
    });
  });
  it('degrades gracefully for a bad URL', () => {
    expect(clusterLinks('not a url')).toEqual({ apiUrl: 'not a url', consoleUrl: '', tokenUrl: '' });
    const html = newNamespaceEmailBody({
      soeid: 'x',
      namespace: 'n',
      cluster: clusterLinks(''),
      recipient: 'r',
    });
    expect(html).not.toContain('OpenShift console');
  });
});

describe('GraphqlUserDirectory', () => {
  const ok =
    (data: unknown): FetchFn =>
    async () =>
      new Response(JSON.stringify(data), { status: 200 });

  it('returns the first name using GraphQL variables (no string interpolation)', async () => {
    let sent: { query: string; variables: { id: string } } | undefined;
    const dir = new GraphqlUserDirectory('http://dir.test', undefined, async (_u, init) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { users: [{ firstName: 'Pat' }] } }), { status: 200 });
    });
    expect(await dir.firstName('pp1')).toBe('Pat');
    expect(sent?.variables.id).toBe('PP1');
    expect(sent?.query).not.toContain('PP1');
  });

  it.each([
    ['no users', { data: { users: [] } }],
    ['no data', {}],
    ['blank name', { data: { users: [{ firstName: '' }] } }],
  ])('returns undefined for %s', async (_l, payload) => {
    expect(
      await new GraphqlUserDirectory('http://d', undefined, ok(payload)).firstName('pp1'),
    ).toBeUndefined();
  });

  it('returns undefined (and warns) on errors', async () => {
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger('debug', (l) => logs.push(JSON.parse(l)));
    const down = new GraphqlUserDirectory('http://d', logger, async () => {
      throw new Error('boom');
    });
    expect(await down.firstName('pp1')).toBeUndefined();
    const bad = new GraphqlUserDirectory('http://d', logger, async () => new Response('', { status: 500 }));
    expect(await bad.firstName('pp1')).toBeUndefined();
    expect(logs.filter((l) => l.event === 'userdirectory.failed')).toHaveLength(2);
  });

  it('NullUserDirectory knows nobody', async () => {
    expect(await new NullUserDirectory().firstName()).toBeUndefined();
  });
});
