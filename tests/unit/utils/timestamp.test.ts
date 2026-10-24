import { describe, expect, it } from 'vitest';
import { durationSince, formatDuration, getFormattedTimestampCST } from '../../../src/utils/timestamp.js';

describe('getFormattedTimestampCST', () => {
  it('formats in America/Chicago as MM-DD-YY HH:mm:ss CST (winter, UTC-6)', () => {
    expect(getFormattedTimestampCST(new Date('2026-01-15T18:30:05Z'))).toBe('01-15-26 12:30:05 CST');
  });

  it('follows daylight saving time (summer, UTC-5)', () => {
    expect(getFormattedTimestampCST(new Date('2026-07-04T18:30:05Z'))).toBe('07-04-26 13:30:05 CST');
  });

  it('uses 00 rather than 24 for midnight', () => {
    expect(getFormattedTimestampCST(new Date('2026-01-15T06:00:00Z'))).toBe('01-15-26 00:00:00 CST');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 seconds'],
    [1, '1 second'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [61, '1 minute 1 second'],
    [185, '3 minutes 5 seconds'],
    [3600, '1 hour'],
    [3660, '1 hour 1 minute'],
    [7500, '2 hours 5 minutes'],
    [-5, '0 seconds'],
    [59.9, '59 seconds'],
  ])('%s s → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('durationSince', () => {
  const now = new Date('2026-01-15T12:00:00Z');
  it('measures from a date or an ISO string', () => {
    expect(durationSince(new Date('2026-01-15T11:58:00Z'), now)).toBe('2 minutes');
    expect(durationSince('2026-01-15T10:00:00Z', now)).toBe('2 hours');
  });
  it('returns 0 seconds when the start is missing or invalid', () => {
    expect(durationSince(undefined, now)).toBe('0 seconds');
    expect(durationSince('not a date', now)).toBe('0 seconds');
  });
});
