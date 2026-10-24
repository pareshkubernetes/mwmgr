import { formatPretty, formatLocalTime, type LogKind } from './log-format.js';
import { appendDailyLog } from '../config/daily-logs.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'json' | 'pretty';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /token|password|authorization|secret|pat$|credential|cookie/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  /** Something finished successfully (a call, a created resource): shown green in the terminal. */
  success(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  source?: { file: string; function: string };
  dailyFiles?: boolean;
  /** `json` (one JSON object per line, for log collectors; the default here) or `pretty` (terminal). */
  format?: LogFormat;
  /** ANSI colours for the pretty format: error red, warn orange, success green, everything else white. */
  color?: boolean;
  /** Clock, replaceable in tests. */
  now?: () => Date;
}

function logSource(error?: Error): { file: string; function: string } {
  for (const frame of (error?.stack ?? new Error().stack ?? '').split('\n').slice(1)) {
    const match = /^\s*at (?:(.*?) \()?(.+?):\d+:\d+\)?$/.exec(frame);
    if (!match) continue;
    const path = match[2]?.replaceAll('\\', '/') ?? '';
    if (/\/(logger\.(?:ts|js))$/.test(path) || path.startsWith('node:')) continue;
    return { file: path.split('/').at(-1) || 'unknown', function: match[1] || 'anonymous' };
  }
  return { file: 'unknown', function: 'anonymous' };
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1),
    ]),
  );
}

export function createLogger(
  level: LogLevel = 'info',
  sink: LogSink = (line) => process.stdout.write(`${line}\n`),
  bindings: LogFields = {},
  options: LoggerOptions = {},
): Logger {
  const format = options.format ?? 'json';
  const now = options.now ?? (() => new Date());

  const write = (kind: LogKind, event: string, fields?: LogFields): void => {
    // `success` is an info-level message that is shown in green
    const severity: Exclude<LogLevel, 'silent'> = kind === 'success' ? 'info' : kind;
    if (ORDER[severity] < ORDER[level]) return;
    const merged = {
      ...(redact(bindings) as LogFields),
      ...(redact(
        fields?.error instanceof Error ? { ...fields, error: fields.error.message } : (fields ?? {}),
      ) as LogFields),
      ...(options.source ?? logSource(fields?.error instanceof Error ? fields.error : undefined)),
    };
    const time = now();
    const timestamp = formatLocalTime(time);
    if (options.dailyFiles)
      appendDailyLog(
        JSON.stringify({ ...merged, time: time.toISOString(), timestamp, level: severity, event }),
        time,
      );
    if (format === 'pretty') {
      sink(formatPretty({ time, kind, event, fields: merged }, options.color === true));
      return;
    }
    sink(
      JSON.stringify({
        time: time.toISOString(),
        timestamp,
        level: severity,
        ...(kind === 'success' ? { outcome: 'success' } : {}),
        event,
        ...merged,
      }),
    );
  };

  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    success: (e, f) => write('success', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    child: (b) => createLogger(level, sink, { ...bindings, ...b }, options),
  };
}

export const silentLogger: Logger = createLogger('silent');
