/**
 * Human-readable log lines for a terminal.
 *
 *   2026-10-24 03:12:45.123 | OK    | request                        | GET    /api/v1/pp1/workspaces -> 200 (12 ms)  requestId=ab12
 *   2026-10-24 03:12:45.200 | ERROR | request.failed                 | code=UPSTREAM_ERROR  error="cluster is down"
 *   2026-10-24 03:12:46.001 | OK    | server.listening
 *       port        : 8080
 *       cluster     : https://api.namctigtd001d.ecs.dyn.nsroot.net:6443
 *       postgres:
 *         host      : NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net
 *
 * Colours (the whole line): errors red, warnings orange, successful calls green, everything else white.
 */

export type LogKind = 'debug' | 'info' | 'success' | 'warn' | 'error';

const ESC = '\u001b[';
export const RESET = `${ESC}0m`;
export const COLORS: Record<LogKind, string> = {
  error: `${ESC}31m`, // red
  warn: `${ESC}38;5;208m`, // orange
  success: `${ESC}32m`, // green
  info: `${ESC}97m`, // white
  debug: `${ESC}97m`, // white
};

const BADGE: Record<LogKind, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  success: 'OK   ',
  info: 'INFO ',
  debug: 'DEBUG',
};

const EVENT_WIDTH = 30;
const BLOCK_INDENT = '    ';
const MAX_INLINE_FIELDS = 6;
const MAX_INLINE_VALUE = 80;
const MAX_INLINE_TOTAL = 120;

export interface LogEntry {
  time: Date;
  kind: LogKind;
  event: string;
  fields: Record<string, unknown>;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local time `2026-10-24 03:12:45.123`. */
export function formatLocalTime(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

type Primitive = string | number | boolean | null | undefined;
const isPrimitive = (v: unknown): v is Primitive => v === null || v === undefined || typeof v !== 'object';
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const oneLine = (s: string): string => s.replace(/\r?\n/g, '\\n');

/** Inline value: bare when simple, quoted when it contains spaces or `=`. */
function inlineValue(v: Primitive): string {
  if (typeof v !== 'string') return String(v);
  const s = oneLine(v);
  return /^[^\s"=]+$/.test(s) ? s : JSON.stringify(s);
}

/** Value on its own line: strings as they are, arrays as compact JSON. */
function blockValue(v: unknown): string {
  if (typeof v === 'string') return oneLine(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function renderBlock(obj: Record<string, unknown>, indent: string): string[] {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  const width = Math.max(
    0,
    ...entries.filter(([, v]) => !isPlainObject(v) || Object.keys(v).length === 0).map(([k]) => k.length),
  );
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      lines.push(`${indent}${key}:`);
      lines.push(...renderBlock(value, `${indent}  `));
    } else {
      const text = isPlainObject(value) ? '{}' : blockValue(value);
      lines.push(`${indent}${key.padEnd(width)} : ${text}`);
    }
  }
  return lines;
}

function canInline(fields: [string, unknown][]): boolean {
  if (fields.length > MAX_INLINE_FIELDS) return false;
  let total = 0;
  for (const [k, v] of fields) {
    if (!isPrimitive(v)) return false;
    const text = inlineValue(v);
    if (text.length > MAX_INLINE_VALUE) return false;
    total += k.length + text.length + 3;
  }
  return total <= MAX_INLINE_TOTAL;
}

/** `GET    /api/v1/x -> 200 (12 ms)` for the per-request log line, plus the fields that are not part of it. */
function requestMessage(
  fields: Record<string, unknown>,
): { message: string; rest: Record<string, unknown> } | undefined {
  const { method, path, status, ms, ...rest } = fields;
  if (typeof method !== 'string' || typeof path !== 'string' || typeof status !== 'number') return undefined;
  const took = typeof ms === 'number' ? ` (${ms} ms)` : '';
  return { message: `${method.padEnd(6)} ${path} -> ${status}${took}`, rest };
}

/** One log entry as text. Multi-line entries end with a blank line so that entries stay visually separate. */
export function formatPretty(entry: LogEntry, color: boolean): string {
  const head = `${formatLocalTime(entry.time)} | ${BADGE[entry.kind]} | `;
  const request = entry.event === 'request' ? requestMessage(entry.fields) : undefined;
  const fields = Object.entries(request ? request.rest : entry.fields).filter(([, v]) => v !== undefined);
  const lines: string[] = [];

  if (fields.length === 0 && !request) {
    lines.push(`${head}${entry.event}`);
  } else if (canInline(fields)) {
    const inline = fields.map(([k, v]) => `${k}=${inlineValue(v as Primitive)}`).join('  ');
    const text = [request?.message, inline].filter(Boolean).join('  ');
    lines.push(`${head}${entry.event.padEnd(EVENT_WIDTH)} | ${text}`);
  } else {
    lines.push(
      request ? `${head}${entry.event.padEnd(EVENT_WIDTH)} | ${request.message}` : `${head}${entry.event}`,
    );
    lines.push(...renderBlock(Object.fromEntries(fields), BLOCK_INDENT));
    lines.push(''); // blank line after a multi-line entry
  }

  const paint = (line: string): string =>
    color && line !== '' ? `${COLORS[entry.kind]}${line}${RESET}` : line;
  return lines.map(paint).join('\n');
}
