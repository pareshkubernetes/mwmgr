import { describe, expect, it } from 'vitest';
import { MetricsRecorder } from '../../../src/services/MetricsRecorder.js';
import { createLogger } from '../../../src/utils/logger.js';
import { FakeClock, FakeMetricsStore } from '../../helpers/fakes.js';

const base = { soeid: 'pp1', eventtype: 'create', resourcetype: 'workspace' } as const;

function setup(timeoutMs = 50) {
  const store = new FakeMetricsStore();
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger('debug', (l) => logs.push(JSON.parse(l)));
  const clock = new FakeClock();
  return { store, logs, clock, recorder: new MetricsRecorder(store, clock, logger, timeoutMs) };
}

describe('MetricsRecorder.record', () => {
  it('stores a record stamped by the clock', async () => {
    const { store, recorder, clock } = setup();
    await recorder.record({ ...base, resourcename: 'ws1' });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ soeid: 'pp1', resourcename: 'ws1', timestamp: clock.now() });
  });

  it('never throws when the database fails, and logs it', async () => {
    const { store, recorder, logs } = setup();
    store.failWith = new Error('connection refused');
    await expect(recorder.record(base)).resolves.toBeUndefined();
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'metrics.insert_failed', error: 'connection refused' }),
    );
  });

  it('gives up on a hung database after the timeout', async () => {
    const { store, recorder, logs } = setup(20);
    store.delayMs = 500;
    const started = Date.now();
    await recorder.record(base);
    expect(Date.now() - started).toBeLessThan(400);
    expect(logs.some((l) => String(l.error).includes('timed out'))).toBe(true);
  });
});

describe('MetricsRecorder.track', () => {
  it('records success and returns the result', async () => {
    const { store, recorder } = setup();
    const result = await recorder.track(
      base,
      async () => 42,
      (n) => ({ storage: n }),
    );
    expect(result).toBe(42);
    expect(store.records[0]).toMatchObject({ storage: 42, status: { failed: false } });
  });

  it('records failure with the error text, then rethrows the original error', async () => {
    const { store, recorder } = setup();
    const boom = new Error('quota exceeded');
    await expect(recorder.track(base, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(store.records[0]?.status).toEqual({ failed: true, error: 'quota exceeded', message: '' });
  });

  it('still returns the result when recording fails', async () => {
    const { store, recorder } = setup();
    store.failWith = new Error('db down');
    await expect(recorder.track(base, async () => 'ok')).resolves.toBe('ok');
  });
});
