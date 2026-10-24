import { appendFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { formatLocalTime } from '../utils/log-format.js';

export const logDirectory = (): string => resolve(process.env.LOG_DIRECTORY || 'logs');
let pending: Promise<void> = Promise.resolve();
export const flushDailyLogs = (): Promise<void> => pending;

/** Files always contain redacted JSON, independently of the console format. UTC date boundaries. */
export function appendDailyLog(line: string, time: Date): void {
  const directory = logDirectory();
  pending = pending
    .then(async () => {
      await mkdir(directory, { recursive: true });
      await appendFile(join(directory, `app-${time.toISOString().slice(0, 10)}.log`), `${line}\n`, {
        mode: 0o600,
      });
    })
    .catch(function reportLogWriteFailure() {
      process.stderr.write(
        `[${formatLocalTime(new Date())}] [daily-logs.ts] [reportLogWriteFailure] | ERROR | Unable to write daily application log\n`,
      );
    });
}

export async function queryLogs(
  options: {
    days: number;
    limit: number;
    level?: string;
    search?: string;
    requestId?: string;
    soeid?: string;
  },
  now = new Date(),
) {
  await pending;
  const from = new Date(now.getTime() - options.days * 86400000);
  const entries: Record<string, unknown>[] = [];
  let scanned = 0;
  let truncated = false;
  // Newest files first, and retain the newest matching entries within each file.
  for (
    let day = new Date(now);
    day.toISOString().slice(0, 10) >= from.toISOString().slice(0, 10);
    day = new Date(day.getTime() - 86400000)
  ) {
    const input = createReadStream(join(logDirectory(), `app-${day.toISOString().slice(0, 10)}.log`), {
      encoding: 'utf8',
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (++scanned > 100000) {
          truncated = true;
          break;
        }
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const time = Date.parse(String(entry.time));
        if (!Number.isFinite(time) || time < from.getTime() || time > now.getTime()) continue;
        if (options.level && entry.level !== options.level) continue;
        if (options.requestId && entry.requestId !== options.requestId) continue;
        if (options.soeid && entry.soeid !== options.soeid) continue;
        if (options.search && !line.toLowerCase().includes(options.search.toLowerCase())) continue;
        entries.push(entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      lines.close();
      input.destroy();
    }
    if (truncated) break;
  }
  entries.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    truncated: truncated || entries.length > options.limit,
    entries: entries.slice(0, options.limit),
  };
}
