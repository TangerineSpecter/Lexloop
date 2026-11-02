import 'reflect-metadata';
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendSystemLogEvent,
  clearSystemLogFiles,
  readSystemLogEvents,
  systemLogDay,
  type SystemLogInput,
} from '../src/modules/admin/system-log-file';
import { SystemLogController } from '../src/modules/admin/system-log.controller';
import { SystemLogExceptionFilter } from '../src/modules/admin/system-log-exception.filter';
import { SystemLogService } from '../src/modules/admin/system-log.service';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';
import { RolesGuard } from '../src/modules/auth/roles.guard';

describe('file-backed administrator system logs', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lexloop-system-logs-'));
    vi.stubEnv('LEXLOOP_LOG_DIR', directory);
    vi.stubEnv('APP_TIMEZONE', 'America/Los_Angeles');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the configured local calendar day and groups only events in the requested date range', async () => {
    expect(systemLogDay(new Date('2026-11-02T07:30:00.000Z'))).toBe('2026-11-01');
    const logs = new SystemLogService();
    await logs.record(event({ at: new Date('2026-11-02T07:30:00.000Z') }));
    await logs.record(
      event({
        at: new Date('2026-11-03T07:30:00.000Z'),
        status: 503,
        reason: '服务器处理请求失败（HTTP 503）；原始异常详情已隐藏。',
      }),
    );

    const withinSecondDay = await logs.list({ from: '2026-11-02', to: '2026-11-02' });
    expect(withinSecondDay.timeZone).toBe('America/Los_Angeles');
    expect(withinSecondDay.groups).toHaveLength(1);
    expect(withinSecondDay.groups[0]).toMatchObject({
      count: 1,
      firstAt: '2026-11-03T07:30:00.000Z',
    });
    expect(withinSecondDay.groups[0].latestDetail.status).toBe(503);
  });

  it('aggregates repeat errors and reports the latest safe detail inside that date range', async () => {
    const logs = new SystemLogService();
    await logs.record(event({ at: new Date('2026-11-03T12:00:00.000Z') }));
    await logs.record(
      event({
        at: new Date('2026-11-03T13:00:00.000Z'),
        reason: '服务器处理请求失败（HTTP 502）；原始异常详情已隐藏。',
      }),
    );
    await logs.record(
      event({ at: new Date('2026-11-04T08:00:00.000Z'), code: 'HTTP_503', status: 503 }),
    );

    const result = await logs.list({ from: '2026-11-03', to: '2026-11-03' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      count: 2,
      firstAt: '2026-11-03T12:00:00.000Z',
      lastAt: '2026-11-03T13:00:00.000Z',
    });
    expect(result.groups[0].latestDetail.status).toBe(500);
    expect(result.groups[0].latestDetail.reason).toContain('HTTP 502');
  });

  it('stores only the safe final system-update check summary and attempt count', async () => {
    const logs = new SystemLogService();
    await logs.record({
      source: 'api',
      kind: 'system.update_check',
      code: 'UPDATE_CHECK_GIT_TLS_INTERRUPTED',
      method: 'GET',
      route: '/api/v1/admin/system/update',
      phase: 'final',
      attemptsMade: 3,
      maxAttempts: 3,
      reason: '更新仓库检查失败；原始 Git 输出已隐藏。',
      at: new Date('2026-11-02T12:00:00.000Z'),
    });

    const result = await logs.list({ from: '2026-11-02', to: '2026-11-02' });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].latestDetail).toMatchObject({
      source: 'api',
      kind: 'system.update_check',
      code: 'UPDATE_CHECK_GIT_TLS_INTERRUPTED',
      attemptsMade: 3,
      maxAttempts: 3,
      reason: '更新仓库检查失败；原始 Git 输出已隐藏。',
    });
  });

  it('does not persist arbitrary exception text, secrets, prompts, query strings, or unknown JSON fields', async () => {
    const secret = 'sk-live-secret-123456789';
    await appendSystemLogEvent({
      ...event(),
      reason: `Authorization: Bearer ${secret}; learner prompt: private answer`,
      route: '/api/v1/items?id=private-answer',
    });
    const logFile = (await readdir(directory)).find((name) => name.endsWith('.jsonl'));
    expect(logFile).toBeTruthy();
    const path = join(directory, logFile!);
    const stored = await readFile(path, 'utf8');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('private answer');
    expect(stored).not.toContain('private-answer');

    const parsed = JSON.parse(stored) as Record<string, unknown>;
    parsed.learnerAnswer = secret;
    await writeFile(path, `${JSON.stringify(parsed)}\n`);
    const result = await readSystemLogEvents('2026-11-01', '2026-11-10');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].reason).toBe('应用记录了一条错误；原始详情已隐藏。');
    expect(result.events[0]).not.toHaveProperty('learnerAnswer');
  });

  it('keeps concurrent same-process writes complete and counts each occurrence once', async () => {
    const logs = new SystemLogService();
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        logs.record(
          event({
            at: new Date(Date.UTC(2026, 10, 3, 12, 0, index)),
          }),
        ),
      ),
    );

    const result = await logs.list({ from: '2026-11-03', to: '2026-11-03' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].count).toBe(60);
  });

  it('clear advances the file epoch, removes retained events, and keeps later events', async () => {
    const logs = new SystemLogService();
    await logs.record(event());
    const clear = await logs.clear();
    expect(clear.clearedAt).toBeTruthy();
    await logs.record(event({ code: 'HTTP_502', status: 502 }));

    const result = await logs.list({ from: '2026-11-01', to: '2026-11-10' });
    expect(result.groups.map((group) => group.code)).toEqual(['HTTP_502']);
    expect(result.groups[0].count).toBe(1);
  });

  it('keeps only the active epoch when a write and clear overlap', async () => {
    await Promise.all([appendSystemLogEvent(event()), clearSystemLogFiles()]);
    const result = await readSystemLogEvents('2026-11-01', '2026-11-10');
    expect(result.events.every((item) => item.epoch === result.state.epoch)).toBe(true);
    expect(result.events.length).toBeLessThanOrEqual(1);
  });

  it('exports the selected range and one group only, with quoted CSV and a stable filename', async () => {
    const logs = new SystemLogService();
    await logs.record(event({ at: new Date('2026-11-03T12:00:00.000Z') }));
    await logs.record(
      event({ at: new Date('2026-11-04T12:00:00.000Z'), code: 'HTTP_503', status: 503 }),
    );

    const all = await logs.exportCsv({ from: '2026-11-03', to: '2026-11-03' });
    expect(all.filename).toBe('lexloop-system-logs-2026-11-03-to-2026-11-03.csv');
    expect(all.csv.match(/\r\n/g)).toHaveLength(2);
    expect(all.csv).toContain('"HTTP_500"');
    expect(all.csv).not.toContain('HTTP_503');

    const one = await logs.exportCsv({
      from: '2026-11-03',
      to: '2026-11-03',
      fingerprint: (await logs.list({ from: '2026-11-03', to: '2026-11-03' })).groups[0]
        .fingerprint,
    });
    expect(one.csv.match(/\r\n/g)).toHaveLength(2);
  });

  it('rejects invalid calendar ranges instead of silently normalizing them', async () => {
    const logs = new SystemLogService();
    await expect(logs.list({ from: '2026-02-30', to: '2026-03-01' })).rejects.toThrow(
      '日志日期范围无效',
    );
    await expect(logs.exportCsv({ from: '2026-11-04', to: '2026-11-03' })).rejects.toThrow(
      '日志日期范围无效',
    );
  });

  it('prunes expired shards and counts malformed retained records without returning them', async () => {
    const old = join(directory, `system-log-api-${process.pid}-2026-01-01-e0.jsonl`);
    await writeFile(old, 'not-json\n');
    const today = systemLogDay(new Date());
    const fresh = join(directory, `system-log-api-${process.pid}-${today}-e0.jsonl`);
    await writeFile(fresh, 'not-json\n');

    const result = await new SystemLogService().list({ from: today, to: today });
    expect(result.groups).toHaveLength(0);
    expect(result.storage.unreadableRecords).toBe(1);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
  });

  it('bounds per-source log files and records capacity drops without putting the event into the log', async () => {
    const today = systemLogDay(new Date());
    const fullFile = join(directory, `system-log-api-${process.pid}-${today}-e0.jsonl`);
    await writeFile(fullFile, '');
    await truncate(fullFile, 49 * 1024 * 1024);
    expect(await appendSystemLogEvent(event())).toBe('dropped');
    const healthFile = (await readdir(directory)).find((name) =>
      name.startsWith('system-log-health-api-'),
    );
    expect(healthFile).toBeTruthy();
    expect(JSON.parse(await readFile(join(directory, healthFile!), 'utf8'))).toMatchObject({
      droppedEvents: 1,
      reason: 'source_capacity_limit',
    });
  });

  it('applies private directory and file modes', async () => {
    await appendSystemLogEvent(event());
    const directoryMode = (await stat(directory)).mode & 0o777;
    const name = (await readdir(directory)).find((item) => item.endsWith('.jsonl'))!;
    const fileMode = (await stat(join(directory, name))).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe('system log access and exception capture', () => {
  it('protects every route with JWT and ADMIN role guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, SystemLogController)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, SystemLogController)).toHaveLength(2);
    const guard = new RolesGuard(new Reflector());
    for (const method of ['list', 'export', 'clear'] as const) {
      const context = (role: Role | undefined) => ({
        getClass: () => SystemLogController,
        getHandler: () => SystemLogController.prototype[method],
        switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
      });
      expect(() => guard.canActivate(context(Role.USER) as never)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context(undefined) as never)).toThrow(ForbiddenException);
      expect(guard.canActivate(context(Role.ADMIN) as never)).toBe(true);
    }
  });

  it('captures sanitized server failures by route template, not request URL or exception text', async () => {
    const record = vi.fn().mockResolvedValue('written');
    const filter = new SystemLogExceptionFilter({ record } as never);
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    const request = {
      method: 'POST',
      routeOptions: { url: '/api/v1/items/:id' },
      url: '/api/v1/items/secret?answer=private',
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ status }) }),
    };
    filter.catch(new Error('private learner answer and api key'), host as never);
    await Promise.resolve();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 500,
        method: 'POST',
        route: '/api/v1/items/:id',
        reason: '服务器处理请求失败（HTTP 500）；原始异常详情已隐藏。',
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
  });

  it('does not count expected client errors as server error events', () => {
    const record = vi.fn();
    const filter = new SystemLogExceptionFilter({ record } as never);
    const send = vi.fn();
    filter.catch(new BadRequestException('invalid input'), {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', routeOptions: { url: '/api/v1/admin/system-logs' } }),
        getResponse: () => ({ status: vi.fn(() => ({ send })) }),
      }),
    } as never);
    expect(record).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

function event(overrides: Partial<SystemLogInput> = {}): SystemLogInput {
  return {
    source: 'api',
    kind: 'http.exception',
    code: 'HTTP_500',
    status: 500,
    method: 'POST',
    route: '/api/v1/items/:id',
    reason: '服务器处理请求失败（HTTP 500）；原始异常详情已隐藏。',
    at: new Date('2026-11-03T12:00:00.000Z'),
    ...overrides,
  };
}
