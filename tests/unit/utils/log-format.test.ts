import { describe, expect, it } from 'vitest';
import {
  COLORS,
  RESET,
  formatLocalTime,
  formatPretty,
  type LogEntry,
  type LogKind,
} from '../../../src/utils/log-format.js';

const time = new Date(2026, 0, 2, 3, 4, 5, 678); // local time, as the formatter prints it
const T = '2026-01-02 03:04:05.678';
const entry = (kind: LogKind, event: string, fields: Record<string, unknown> = {}): LogEntry => ({
  time,
  kind,
  event,
  fields,
});
const plain = (e: LogEntry) => formatPretty(e, false);

describe('colours: errors red, warnings orange, successes green, everything else white', () => {
  it('uses exactly these ANSI codes', () => {
    expect(COLORS.error).toBe('\u001b[31m'); // red
    expect(COLORS.warn).toBe('\u001b[38;5;208m'); // orange
    expect(COLORS.success).toBe('\u001b[32m'); // green
    expect(COLORS.info).toBe('\u001b[97m'); // bright white
    expect(COLORS.debug).toBe(COLORS.info); // white as well
  });

  it.each(['error', 'warn', 'success', 'info', 'debug'] as const)(
    '%s line is painted in its colour',
    (kind) => {
      const out = formatPretty(entry(kind, 'some.event', { a: 1 }), true);
      expect(out.startsWith(COLORS[kind])).toBe(true);
      expect(out.endsWith(RESET)).toBe(true);
    },
  );

  it('every line of a multi-line entry is painted on its own, the separating blank line is not', () => {
    const out = formatPretty(entry('error', 'boom', { a: { b: 1 }, c: 2 }), true);
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.at(-1)).toBe('');
    for (const line of lines.slice(0, -1)) {
      expect(line.startsWith(COLORS.error), line).toBe(true);
      expect(line.endsWith(RESET), line).toBe(true);
      expect(line.slice(COLORS.error.length, -RESET.length)).not.toContain('\u001b');
    }
  });

  it('prints no escape codes at all when colour is off', () => {
    for (const kind of ['error', 'warn', 'success', 'info', 'debug'] as const) {
      expect(plain(entry(kind, 'e', { a: { b: 1 } }))).not.toContain('\u001b');
    }
  });
});

describe('layout', () => {
  it('formats local time as YYYY-MM-DD HH:mm:ss.SSS', () => {
    expect(formatLocalTime(time)).toBe(T);
    expect(formatLocalTime(new Date(2026, 10, 9, 23, 59, 1, 5))).toBe('2026-11-09 23:59:01.005');
  });

  it('a bare event is one line: time | LEVEL | event', () => {
    expect(plain(entry('info', 'server.shutdown'))).toBe(`${T} | INFO  | server.shutdown`);
  });

  it('level badges all have the same width so the columns line up', () => {
    const widths = (['error', 'warn', 'success', 'info', 'debug'] as const).map((k) =>
      plain(entry(k, 'e')).indexOf(' | e'),
    );
    expect(new Set(widths).size).toBe(1);
    expect(plain(entry('error', 'e'))).toContain('| ERROR |');
    expect(plain(entry('warn', 'e'))).toContain('| WARN  |');
    expect(plain(entry('success', 'e'))).toContain('| OK    |');
    expect(plain(entry('debug', 'e'))).toContain('| DEBUG |');
  });

  it('a few short fields stay on the same line, as key=value separated by two spaces', () => {
    expect(plain(entry('warn', 'metrics.columns_missing', { table: 't1', missing: 'a,b' }))).toBe(
      `${T} | WARN  | ${'metrics.columns_missing'.padEnd(30)} | table=t1  missing=a,b`,
    );
  });

  it('quotes inline values that contain spaces or =, and escapes newlines', () => {
    const out = plain(
      entry('error', 'x', { error: 'cluster is down', eq: 'a=b', multi: 'l1\nl2', bare: 'ok-1' }),
    );
    expect(out).toContain('error="cluster is down"');
    expect(out).toContain('eq="a=b"');
    expect(out).toContain('multi=l1\\nl2'); // the newline becomes a visible \n, so the entry stays on one line
    expect(out).toContain('bare=ok-1');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('shows the per-request line as: METHOD path -> status (ms) plus the ids', () => {
    const out = plain(
      entry('success', 'request', {
        method: 'GET',
        path: '/api/v1/pp1/workspaces',
        status: 200,
        ms: 12,
        requestId: 'r-1',
        soeid: 'pp1',
      }),
    );
    expect(out).toBe(
      `${T} | OK    | ${'request'.padEnd(30)} | GET    /api/v1/pp1/workspaces -> 200 (12 ms)  requestId=r-1  soeid=pp1`,
    );
  });

  it('leaves out fields that have no value (a request without a user)', () => {
    const out = plain(
      entry('success', 'request', { method: 'GET', path: '/api/v1/healthz', status: 200, ms: 1, soeid: undefined }),
    );
    expect(out).not.toContain('soeid');
    expect(out).not.toContain('undefined');
  });

  it('puts nested and long data on indented lines with aligned colons, and ends with a blank line', () => {
    const out = plain(
      entry('success', 'server.listening', {
        port: 8080,
        cluster: 'https://x',
        editors: { vscode: 'a', intellij: 'b' },
        postgres: 'disabled',
        empty: {},
        list: [1, 2],
        gone: undefined,
      }),
    );
    expect(out).toBe(
      [
        `${T} | OK    | server.listening`,
        '    port     : 8080',
        '    cluster  : https://x',
        '    editors:',
        '      vscode   : a',
        '      intellij : b',
        '    postgres : disabled',
        '    empty    : {}',
        '    list     : [1,2]',
        '',
      ].join('\n'),
    );
  });

  it('switches to the indented layout for many fields, or a long value', () => {
    const many = plain(entry('info', 'e', { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }));
    expect(many.split('\n')[0]).toBe(`${T} | INFO  | e`);
    expect(many).toContain('    g : 7');

    const long = plain(entry('error', 'e', { error: 'x'.repeat(100) }));
    expect(long.split('\n')[0]).toBe(`${T} | ERROR | e`);
    expect(long).toContain(`    error : ${'x'.repeat(100)}`);
  });

  it('an error with a request id and a message gets its own block, easy to read', () => {
    const out = plain(
      entry('error', 'request.failed', {
        requestId: '7989eb27-2d84-4d15-aa0b-95003ff51f85',
        code: 'UPSTREAM_ERROR',
        error: 'Devfile registry catalog: No response received from server',
      }),
    );
    expect(out).toBe(
      [
        `${T} | ERROR | request.failed`,
        '    requestId : 7989eb27-2d84-4d15-aa0b-95003ff51f85',
        '    code      : UPSTREAM_ERROR',
        '    error     : Devfile registry catalog: No response received from server',
        '',
      ].join('\n'),
    );
  });

  it('treats a "request" event without method/path/status as an ordinary entry', () => {
    expect(plain(entry('info', 'request', { note: 'hi' }))).toBe(
      `${T} | INFO  | ${'request'.padEnd(30)} | note=hi`,
    );
  });
});
