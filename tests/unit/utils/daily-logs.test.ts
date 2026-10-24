import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryLogs } from '../../../src/config/daily-logs.js';
import { createLogger } from '../../../src/utils/logger.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workspace-logs-'));
  vi.stubEnv('LOG_DIRECTORY', directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const now = new Date('2026-10-24T12:00:00Z');
describe('daily JSON logs', () => {
  it('rotates by UTC date, redacts secrets, and searches across days', async () => {
    let time = new Date('2026-10-23T13:00:00Z');
    const logger = createLogger(
      'info',
      () => {},
      {},
      { format: 'pretty', dailyFiles: true, now: () => time },
    );
    logger.info('project.created', { token: 'never-return', soeid: 'pp1', requestId: 'request-1' });
    time = new Date('2026-10-24T11:00:00Z');
    logger.error('project.failed', { soeid: 'pp2' });
    const all = await queryLogs({ days: 2, limit: 10 }, now);
    expect(all.entries.map((e) => e.event)).toEqual(['project.failed', 'project.created']);
    expect(await readFile(join(directory, 'app-2026-10-23.log'), 'utf8')).not.toContain('never-return');
    expect(
      (
        await queryLogs(
          { days: 1, limit: 10, level: 'info', soeid: 'pp1', requestId: 'request-1', search: 'CREATED' },
          now,
        )
      ).entries,
    ).toHaveLength(1);
    expect((await queryLogs({ days: 1, limit: 1 }, now)).truncated).toBe(true);
    expect((await queryLogs({ days: 1, limit: 10, requestId: 'missing' }, now)).entries).toHaveLength(0);
    expect((await queryLogs({ days: 1, limit: 10, soeid: 'missing' }, now)).entries).toHaveLength(0);
    expect((await queryLogs({ days: 1, limit: 10, search: 'missing' }, now)).entries).toHaveLength(0);
  });
  it('ignores malformed, old and future entries and absent dates', async () => {
    await writeFile(
      join(directory, 'app-2026-10-24.log'),
      [
        'not-json',
        JSON.stringify({ time: 'invalid' }),
        JSON.stringify({ time: '2026-10-25T00:00:00Z' }),
        JSON.stringify({ time: '2026-10-20T00:00:00Z' }),
      ].join('\n'),
    );
    expect((await queryLogs({ days: 1, limit: 10 }, now)).entries).toEqual([]);
  });
});
