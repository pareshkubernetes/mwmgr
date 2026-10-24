import { buildLogRecord, type MetricsInput } from '../factories/log-factory.js';
import type { MetricsRecord } from '../types.js';
import { systemClock, type Clock, type MetricsStore } from '../infra/ports.js';
import { errorMessage } from '../utils/errors.js';
import { silentLogger, type Logger } from '../utils/logger.js';

export type MetricBase = MetricsInput;

/**
 * Writes one metrics row per user action. Recording is best-effort: a slow or broken database is logged
 * and never fails the user's action.
 */
export class MetricsRecorder {
  constructor(
    private readonly store: MetricsStore,
    private readonly clock: Clock = systemClock,
    private readonly logger: Logger = silentLogger,
    private readonly timeoutMs = 2000,
  ) {}

  async record(input: MetricsInput): Promise<void> {
    const record = buildLogRecord(input, this.clock.now());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.store.insert(record),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`metrics insert timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.logger.error('metrics.insert_failed', {
        soeid: record.soeid,
        eventtype: record.eventtype,
        resourcetype: record.resourcetype,
        error: errorMessage(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Run `fn`, record success (with optional extra fields from the result) or failure, and pass the outcome through. */
  async track<T>(
    base: MetricBase,
    fn: () => Promise<T>,
    onSuccess?: (result: T) => Partial<MetricsRecord>,
  ): Promise<T> {
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      await this.record({ ...base, status: { failed: true, error: errorMessage(error), message: '' } });
      throw error;
    }
    await this.record({ ...base, ...(onSuccess?.(result) ?? {}) });
    return result;
  }
}
