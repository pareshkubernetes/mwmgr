import type { AppConfig } from '../../config/env.js';
import { silentLogger, type Logger } from '../../utils/logger.js';
import type {
  NamespaceCreatedEmail,
  NamespaceExistsEmail,
  NamespacesDeletedEmail,
  Notifier,
  UserDirectory,
} from '../ports.js';
import {
  clusterLinks,
  deletedNamespacesEmailBody,
  existingNamespaceEmailBody,
  newNamespaceEmailBody,
} from './email-templates.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class EmailNotifier implements Notifier {
  constructor(
    private readonly config: AppConfig['notification'],
    private readonly clusterApiUrl: string,
    private readonly directory: UserDirectory,
    private readonly logger: Logger = silentLogger,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  async namespaceCreated(e: NamespaceCreatedEmail): Promise<void> {
    await this.send(e.soeid, 'Success! Your DevSpaces Deployment Project is Ready!', (firstName, recipient) =>
      newNamespaceEmailBody({
        firstName,
        soeid: e.soeid,
        namespace: e.namespace,
        cluster: clusterLinks(this.clusterApiUrl),
        recipient,
      }),
    );
  }

  async namespaceAlreadyExists(e: NamespaceExistsEmail): Promise<void> {
    await this.send(
      e.soeid,
      'Important: Your DevSpaces Deployment Project Already Exists',
      (firstName, recipient) =>
        existingNamespaceEmailBody({
          firstName,
          soeid: e.soeid,
          newNamespace: e.newNamespace,
          existingNamespace: e.existingNamespace,
          cluster: clusterLinks(this.clusterApiUrl),
          recipient,
        }),
    );
  }

  async namespacesDeleted(e: NamespacesDeletedEmail): Promise<void> {
    if (e.namespaces.length === 0) return;
    await this.send(
      e.soeid,
      'Confirmation: DevSpaces Deployment Project(s) Deleted',
      (firstName, recipient) =>
        deletedNamespacesEmailBody({ firstName, soeid: e.soeid, namespaces: e.namespaces, recipient }),
    );
  }

  private async send(
    soeid: string,
    subject: string,
    body: (firstName: string | undefined, recipient: string) => string,
  ): Promise<void> {
    const { url, username, password, sender, cc, emailDomain } = this.config;
    if (!url) {
      this.logger.debug('email.skipped', { reason: 'NOTIFICATION_MAIL_URL not set', subject });
      return;
    }
    const recipient = `${soeid}@${emailDomain}`;
    try {
      const firstName = await this.directory.firstName(soeid);
      const response = await this.fetchFn(`${url.replace(/\/$/, '')}/send-mail/v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        },
        body: JSON.stringify({
          sender,
          receiver: recipient,
          receiverName: soeid.toUpperCase(),
          cc: cc ?? '',
          bcc: '',
          subject,
          emailMessage: body(firstName, recipient),
          isHtml: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`mail service answered ${response.status}`);
      this.logger.success('email.sent', { soeid, subject });
    } catch (error) {
      this.logger.error('email.failed', { soeid, subject, error: error });
    }
  }
}

export class NoopNotifier implements Notifier {
  async namespaceCreated(): Promise<void> {}
  async namespaceAlreadyExists(): Promise<void> {}
  async namespacesDeleted(): Promise<void> {}
}
