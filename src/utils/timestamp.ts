const formatter = new Intl.DateTimeFormat('en-US', {
  month: '2-digit',
  day: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'America/Chicago',
});

/** `MM-DD-YY HH:mm:ss CST` in the America/Chicago zone (for logs and emails only). */
export function getFormattedTimestampCST(date: Date = new Date()): string {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.month}-${parts.day}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second} CST`;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** `45 seconds`, `3 minutes 5 seconds`, `2 hours 10 minutes`. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return plural(seconds, 'second');
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest > 0 ? `${plural(minutes, 'minute')} ${plural(rest, 'second')}` : plural(minutes, 'minute');
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes > 0 ? `${plural(hours, 'hour')} ${plural(minutes, 'minute')}` : plural(hours, 'hour');
}

export function durationSince(from: Date | string | undefined, now: Date = new Date()): string {
  if (!from) return '0 seconds';
  const start = typeof from === 'string' ? new Date(from) : from;
  if (Number.isNaN(start.getTime())) return '0 seconds';
  return formatDuration((now.getTime() - start.getTime()) / 1000);
}
