export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /token|password|authorization|secret|pat$|credential|cookie/i;

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

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
  bindings: Record<string, unknown> = {},
): Logger {
  const write = (lvl: Exclude<LogLevel, 'silent'>, event: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(
      JSON.stringify({
        time: new Date().toISOString(),
        level: lvl,
        event,
        ...(redact(bindings) as object),
        ...(redact(fields ?? {}) as object),
      }),
    );
  };
  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    child: (b) => createLogger(level, sink, { ...bindings, ...b }),
  };
}

export const silentLogger: Logger = createLogger('silent');
