import { describe, expect, it, vi } from 'vitest';
import { SystemUpdateController } from '../src/modules/admin/system-update.controller';

const failedStatus = {
  currentVersion: '1.27.118',
  currentSha: 'a'.repeat(40),
  updaterAvailable: true,
  error: 'GitHub TLS 连接中断；已有限重试，远端版本尚未确认。',
  checkErrorCode: 'GIT_TLS_INTERRUPTED',
  checkAttemptId: 'ac81a4c0-f155-4ecb-8f8e-33c138fd2c35',
  checkAttemptedAt: '2026-11-02T10:00:00.000Z',
  checkFinishedAt: '2026-11-02T10:01:01.000Z',
  checkAttempts: 3,
  checkInProgress: false,
  latest: null,
  updateAvailable: false,
  sameVersionRevision: false,
  checkedAt: null,
  job: null,
};

describe('SystemUpdateController', () => {
  it('records one safe admin-log event per failed updater check attempt', async () => {
    const updates = {
      status: vi.fn().mockResolvedValue(failedStatus),
      check: vi.fn().mockResolvedValue(failedStatus),
    };
    const logs = { record: vi.fn().mockResolvedValue('written') };
    const controller = new SystemUpdateController(updates as never, logs as never);

    await controller.status();
    await controller.check();

    expect(logs.record).toHaveBeenCalledTimes(1);
    expect(logs.record).toHaveBeenCalledWith({
      source: 'api',
      kind: 'system.update_check',
      code: 'UPDATE_CHECK_GIT_TLS_INTERRUPTED',
      method: 'GET',
      route: '/api/v1/admin/system/update',
      phase: 'final',
      attemptsMade: 3,
      maxAttempts: 3,
      reason: '更新仓库检查失败；原始 Git 输出已隐藏。',
      at: new Date('2026-11-02T10:01:01.000Z'),
    });
  });

  it('does not log unavailable updater state or unrecognized error codes', async () => {
    const updates = {
      status: vi
        .fn()
        .mockResolvedValueOnce({ ...failedStatus, updaterAvailable: false })
        .mockResolvedValueOnce({ ...failedStatus, checkErrorCode: 'UNTRUSTED_RAW_ERROR' }),
      check: vi.fn(),
    };
    const logs = { record: vi.fn() };
    const controller = new SystemUpdateController(updates as never, logs as never);

    await controller.status();
    await controller.status();

    expect(logs.record).not.toHaveBeenCalled();
  });

  it('exposes and saves the administrator-controlled auto-update schedule through the updater service', async () => {
    const autoStatus = {
      available: true,
      enabled: false,
      intervalHours: 24,
      lastCheckAt: null,
      nextCheckAt: null,
      lastCheckResult: 'never',
      lastCheckErrorCode: null,
      lastUpdateAt: null,
      lastUpdateResult: 'never',
      lastUpdateError: null,
    };
    const updates = {
      status: vi.fn().mockResolvedValue({ ...failedStatus, error: null, checkErrorCode: null }),
      check: vi.fn(),
      autoUpdateStatus: vi.fn().mockResolvedValue(autoStatus),
      saveAutoUpdate: vi.fn().mockResolvedValue({ ...autoStatus, enabled: true, intervalHours: 6 }),
    };
    const logs = { record: vi.fn() };
    const controller = new SystemUpdateController(updates as never, logs as never);

    expect(await controller.autoUpdateStatus()).toEqual(autoStatus);
    expect(
      await controller.saveAutoUpdate({ enabled: true, intervalHours: 6 } as never),
    ).toMatchObject({ enabled: true, intervalHours: 6 });
    expect(updates.saveAutoUpdate).toHaveBeenCalledWith({ enabled: true, intervalHours: 6 });
  });
});
