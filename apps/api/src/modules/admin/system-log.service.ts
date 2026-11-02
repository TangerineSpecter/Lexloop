import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  appendSystemLogEvent,
  clearSystemLogFiles,
  pruneSystemLogRetention,
  scanSystemLogEvents,
  shiftSystemLogDay,
  systemLogDay,
  systemLogTimeZone,
  type SystemLogEvent,
  type SystemLogInput,
  type SystemLogSource,
} from './system-log-file';

export type SystemLogFilters = {
  from?: string;
  to?: string;
  source?: SystemLogSource;
  search?: string;
};

type SystemLogGroup = {
  fingerprint: string;
  source: SystemLogSource;
  kind: string;
  code: string;
  count: number;
  firstAt: string;
  lastAt: string;
  latestDetail: SystemLogEvent;
};

const RETENTION_DAYS = 14;
const MAX_STORAGE_BYTES = 100 * 1024 * 1024;
const MAX_LIST_GROUPS = 500;
const MAX_EXPORT_GROUPS = 5000;

@Injectable()
export class SystemLogService {
  private localWriteFailures = 0;

  async record(input: SystemLogInput) {
    const result = await appendSystemLogEvent(input);
    if (result === 'unavailable') this.localWriteFailures += 1;
    return result;
  }

  async list(filters: SystemLogFilters = {}) {
    const { from, to } = normalizeRange(filters);
    await pruneSystemLogRetention();
    const collected = new Map<string, SystemLogGroup>();
    const snapshot = await scanSystemLogEvents(from, to, (event) =>
      this.addEvent(collected, event, filters),
    );
    const groups = this.finishGroups(collected, filters);
    return {
      timeZone: systemLogTimeZone(),
      range: { from, to },
      retentionDays: RETENTION_DAYS,
      storage: {
        usedBytes: snapshot.usedBytes,
        maxBytes: MAX_STORAGE_BYTES,
        droppedEvents: snapshot.droppedEvents,
        apiWriteFailuresSinceStart: this.localWriteFailures,
        unreadableRecords: snapshot.unreadableFiles,
      },
      totalGroups: groups.length,
      truncatedGroups: Math.max(0, groups.length - MAX_LIST_GROUPS),
      groups: groups.slice(0, MAX_LIST_GROUPS),
    };
  }

  async exportCsv(filters: SystemLogFilters & { fingerprint?: string } = {}) {
    const { from, to } = normalizeRange(filters);
    await pruneSystemLogRetention();
    const collected = new Map<string, SystemLogGroup>();
    const snapshot = await scanSystemLogEvents(from, to, (event) =>
      this.addEvent(collected, event, filters),
    );
    let groups = this.finishGroups(collected, filters);
    if (filters.fingerprint) {
      groups = groups.filter((group) => group.fingerprint === filters.fingerprint);
      if (!groups.length) throw new NotFoundException('所选日志在该日期范围内不存在');
    }
    if (groups.length > MAX_EXPORT_GROUPS) {
      throw new BadRequestException(
        `所选范围包含超过 ${MAX_EXPORT_GROUPS} 类错误，请缩小日期或关键字范围后导出。`,
      );
    }
    const header = [
      'fingerprint',
      'source',
      'kind',
      'code',
      'count',
      'first_at',
      'last_at',
      'http_status',
      'upstream_status',
      'param',
      'method',
      'route',
      'phase',
      'attempts_made',
      'max_attempts',
      'reason',
    ];
    const rows = groups.map((group) => {
      const detail = group.latestDetail;
      return [
        group.fingerprint,
        group.source,
        group.kind,
        group.code,
        group.count,
        group.firstAt,
        group.lastAt,
        detail.status,
        detail.upstreamStatus,
        detail.param,
        detail.method,
        detail.route,
        detail.phase,
        detail.attemptsMade,
        detail.maxAttempts,
        detail.reason,
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    return {
      filename: filters.fingerprint
        ? `lexloop-system-log-${filters.fingerprint.slice(0, 12)}.csv`
        : `lexloop-system-logs-${from}-to-${to}.csv`,
      csv: `\uFEFF${csv}\r\n`,
    };
  }

  async clear() {
    const state = await clearSystemLogFiles();
    return { clearedAt: state.clearedAt, timeZone: systemLogTimeZone() };
  }

  private addEvent(
    groups: Map<string, SystemLogGroup>,
    event: SystemLogEvent,
    filters: SystemLogFilters,
  ) {
    if (filters.source && event.source !== filters.source) return;
    const current = groups.get(event.fingerprint);
    if (current) {
      current.count += 1;
      if (event.at < current.firstAt) current.firstAt = event.at;
      if (
        event.at > current.lastAt ||
        (event.at === current.lastAt &&
          JSON.stringify(event) > JSON.stringify(current.latestDetail))
      ) {
        current.lastAt = event.at;
        current.latestDetail = event;
      }
      return;
    }
    groups.set(event.fingerprint, {
      fingerprint: event.fingerprint,
      source: event.source,
      kind: event.kind,
      code: event.code,
      count: 1,
      firstAt: event.at,
      lastAt: event.at,
      latestDetail: event,
    });
  }

  private finishGroups(
    groups: Map<string, SystemLogGroup>,
    filters: SystemLogFilters,
  ): SystemLogGroup[] {
    const search = filters.search?.trim().toLocaleLowerCase();
    return [...groups.values()]
      .filter((group) => {
        if (!search) return true;
        const detail = group.latestDetail;
        return [group.source, group.kind, group.code, detail.param, detail.route, detail.reason]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(search);
      })
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
}

export function normalizeRange(filters: SystemLogFilters): { from: string; to: string } {
  const today = systemLogDay(new Date());
  const to = filters.to ?? today;
  const from = filters.from ?? shiftSystemLogDay(to, -6);
  if (!isDateKey(from) || !isDateKey(to) || from > to) {
    throw new BadRequestException('日志日期范围无效，请选择正确的起止日期。');
  }
  return { from, to };
}

function isDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
