import { silentLogger, type Logger } from '../../utils/logger.js';
import type { UserDirectory } from '../ports.js';
import type { FetchFn } from './EmailNotifier.js';

const QUERY = 'query($id: String!) { users(filter: { soeId: { equals: $id } }) { firstName } }';

export class GraphqlUserDirectory implements UserDirectory {
  constructor(
    private readonly url: string,
    private readonly logger: Logger = silentLogger,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  async firstName(soeid: string): Promise<string | undefined> {
    try {
      const response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { id: soeid.toUpperCase() } }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`user directory answered ${response.status}`);
      const json = (await response.json()) as { data?: { users?: { firstName?: string }[] } };
      return json.data?.users?.[0]?.firstName || undefined;
    } catch (error) {
      this.logger.warn('userdirectory.failed', { soeid, error: error });
      return undefined;
    }
  }
}

export class NullUserDirectory implements UserDirectory {
  async firstName(): Promise<string | undefined> {
    return undefined;
  }
}
