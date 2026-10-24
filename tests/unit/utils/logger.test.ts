import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../../src/utils/logger.js';

function capture(level: Parameters<typeof createLogger>[0] = 'info') {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: createLogger(level, (l) => lines.push(JSON.parse(l))) };
}

describe('logger', () => {
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

  it('serialises errors as name and message only', () => {
    expect(redact(new Error('bad'))).toEqual({ name: 'Error', message: 'bad' });
  });

  it('stops redacting past a sane depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(redact(deep)).toEqual(deep);
  });
});
