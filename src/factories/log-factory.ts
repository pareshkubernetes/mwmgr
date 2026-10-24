import type { MetricsRecord } from '../domain/types.js';

export type MetricsInput = Pick<MetricsRecord, 'soeid' | 'eventtype' | 'resourcetype'> &
  Partial<MetricsRecord>;

/** Fill a metrics row with the same defaults the legacy log factory used. */
export function buildLogRecord(data: MetricsInput, now: Date = new Date()): MetricsRecord {
  return {
    timestamp: data.timestamp ?? now,
    csiid: data.csiid ?? '',
    soeid: data.soeid,
    eventtype: data.eventtype,
    resourcename: data.resourcename ?? '',
    resourcetype: data.resourcetype,
    status: data.status ?? { failed: false, error: '', message: '' },
    useraction: data.useraction ?? 'user',
    limitcpu: data.limitcpu ?? 0,
    limitmemory: data.limitmemory ?? 0,
    requestcpu: data.requestcpu ?? 0,
    requestmemory: data.requestmemory ?? 0,
    duration: data.duration ?? '0 seconds',
    storage: data.storage ?? 0,
    workspaceversion: data.workspaceversion ?? '',
    editorname: data.editorname ?? '',
  };
}
