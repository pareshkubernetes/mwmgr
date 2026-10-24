import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../../src/utils/logger.js';

function capture(level: Parameters<typeof createLogger>[0] = 'info') {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: createLogger(level, (l) => lines.push(JSON.parse(l))) };
}

describe('logger', () => {
  it('records the calling file and function with a seconds-resolution timestamp', () => {
    const { lines, logger } = capture();
    function recordEvent() {
      logger.info('source.test');
    }
    recordEvent();
    expect(lines[0]).toMatchObject({ file: 'logger.test.ts', function: 'recordEvent' });
    expect(lines[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  it('uses an error stack to identify its original file and function', () => {
    const { lines, logger } = capture();
    const error = new Error('creation failed');
    error.stack =
      'Error: creation failed\n    at NamespaceService.ensure (C:\\app\\src\\services\\NamespaceService.ts:42:10)';
    logger.error('namespace.failed', { error });
    expect(lines[0]).toMatchObject({
      file: 'NamespaceService.ts',
      function: 'NamespaceService.ensure',
      error: 'creation failed',
    });
    expect(JSON.stringify(lines[0])).not.toContain('C:\\app');
  });
  it('writes one JSON line with level, event and fields', () => {
    const { lines, logger } = capture();
    logger.info('hello', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'hello', a: 1 });
    expect(typeof lines[0]?.time).toBe('string');
  });

  it('filters below the configured level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.event)).toEqual(['w', 'e']);
  });

  it('is silent when asked', () => {
    const { lines, logger } = capture('silent');
    logger.error('e');
    expect(lines).toHaveLength(0);
  });

  it('child loggers carry bindings', () => {
    const { lines, logger } = capture();
    logger.child({ requestId: 'r1' }).info('x', { b: 2 });
    expect(lines[0]).toMatchObject({ requestId: 'r1', b: 2 });
  });

  it('redacts sensitive keys, nested and in arrays', () => {
    const { lines, logger } = capture();
    logger.info('x', {
      token: 'ghp_secret',
      nested: { password: 'p', ok: 1 },
      list: [{ authorization: 'Bearer x' }],
    });
    expect(lines[0]).toMatchObject({
      token: '[redacted]',
      nested: { password: '[redacted]', ok: 1 },
      list: [{ authorization: '[redacted]' }],
    });
    expect(JSON.stringify(lines[0])).not.toContain('ghp_secret');
  });

  it('success is an info-level line marked as a success, and hidden when only warnings are wanted', () => {
    const { lines, logger } = capture();
    logger.success('workspace.created', { workspace: 'w1' });
    expect(lines[0]).toMatchObject({
      level: 'info',
      outcome: 'success',
      event: 'workspace.created',
      workspace: 'w1',
    });
    const quiet = capture('warn');
    quiet.logger.success('workspace.created');
    expect(quiet.lines).toHaveLength(0);
  });

  it('plain info lines carry no outcome', () => {
    const { lines, logger } = capture();
    logger.info('x');
    expect(lines[0]).not.toHaveProperty('outcome');
  });

  describe('pretty format (terminal)', () => {
    const now = () => new Date(2026, 0, 2, 3, 4, 5, 678);
    const pretty = (level: Parameters<typeof createLogger>[0] = 'info', color = true) => {
      const out: string[] = [];
      return {
        out,
        logger: createLogger(
          level,
          (l) => out.push(l),
          {},
          { format: 'pretty', color, now, source: { file: 'logger.test.ts', function: 'testLog' } },
        ),
      };
    };

    it('paints each kind in its colour: error red, warn orange, success green, info and debug white', () => {
      const { out, logger } = pretty('debug');
      logger.error('e');
      logger.warn('w');
      logger.success('s');
      logger.info('i');
      logger.debug('d');
      expect(out).toEqual([
        '\u001b[31m[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | ERROR | e\u001b[0m',
        '\u001b[38;5;208m[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | WARN  | w\u001b[0m',
        '\u001b[32m[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | OK    | s\u001b[0m',
        '\u001b[97m[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | INFO  | i\u001b[0m',
        '\u001b[97m[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | DEBUG | d\u001b[0m',
      ]);
    });

    it('writes one sink call per entry, plain when colour is off', () => {
      const { out, logger } = pretty('info', false);
      logger.info('a', { n: 1 });
      logger.warn('b');
      expect(out).toEqual([
        `[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | INFO  | ${'a'.padEnd(30)} | n=1`,
        '[2026-01-02 03:04:05] [File: logger.test.ts] [Function: testLog] | WARN  | b',
      ]);
    });

    it('applies the level filter, bindings of child loggers, and redaction', () => {
      const { out, logger } = pretty('info', false);
      logger.debug('hidden');
      logger.child({ requestId: 'r1' }).info('x', { token: 'ghp_secret', ok: 1 });
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('requestId=r1');
      expect(out[0]).toContain('token=[redacted]');
      expect(out[0]).not.toContain('ghp_secret');
    });

    it('child loggers keep the format and colour of their parent', () => {
      const { out, logger } = pretty('info', true);
      logger.child({ a: 1 }).error('boom');
      expect(out[0]?.startsWith('\u001b[31m')).toBe(true);
    });

    it('the default is still JSON, so existing log collectors keep working', () => {
      const lines: string[] = [];
      createLogger('info', (l) => lines.push(l)).info('x');
      expect(JSON.parse(lines[0] as string)).toMatchObject({ event: 'x', level: 'info' });
    });
  });

  it('serialises errors as name and message only', () => {
    expect(redact(new Error('bad'))).toEqual({ name: 'Error', message: 'bad' });
  });

  it('stops redacting past a sane depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(redact(deep)).toEqual(deep);
  });
});
