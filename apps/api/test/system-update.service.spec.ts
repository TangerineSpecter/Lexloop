import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SystemUpdateService } from '../src/modules/admin/system-update.service';

const status = {
  currentVersion: '1.27.118',
  currentSha: 'a'.repeat(40),
  updaterAvailable: true,
  error: null,
  latest: null,
  updateAvailable: false,
  sameVersionRevision: false,
  checkedAt: '2026-11-02T09:55:00.000Z',
  job: null,
};

describe('SystemUpdateService', () => {
  it('does not forward an update when manual password verification fails', async () => {
    const auth = { verifyPassword: vi.fn().mockRejectedValue(new UnauthorizedException()) };
    const service = new SystemUpdateService(auth as never);
    const call = vi.spyOn(service as never, 'call');

    await expect(
      service.apply(
        { sub: 'admin-1', email: 'admin@example.com' },
        { targetVersion: '1.1.0', targetSha: 'a'.repeat(40), password: 'wrong-password' },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps manual updates password-confirmed and omits the password from updater requests', async () => {
    const auth = { verifyPassword: vi.fn().mockResolvedValue(true) };
    const service = new SystemUpdateService(auth as never);
    const call = vi
      .spyOn(service as never, 'call')
      .mockResolvedValue({ jobId: '00000000-0000-4000-8000-000000000000', stage: 'CHECKING' });

    await service.apply(
      { sub: 'admin-1', email: 'admin@example.com' },
      { targetVersion: '1.1.0', targetSha: 'a'.repeat(40), password: 'correct-password' },
    );

    expect(auth.verifyPassword).toHaveBeenCalledWith('admin-1', 'correct-password');
    expect(call).toHaveBeenCalledWith(
      'POST',
      '/apply',
      expect.objectContaining({
        targetVersion: '1.1.0',
        targetSha: 'a'.repeat(40),
        actorId: 'admin-1',
        actorEmail: 'admin@example.com',
      }),
    );
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('password');
  });

  it('hides legacy raw Git stderr before returning updater status to clients', async () => {
    const service = new SystemUpdateService({} as never);
    vi.spyOn(service as never, 'call').mockResolvedValue({
      ...status,
      error:
        "fatal: unable to access 'https://github.com/user:password@host/repo.git': server response with private token",
    });

    const result = await service.status();

    expect(result.checkErrorCode).toBe('GIT_FETCH_FAILED');
    expect(result.error).toBe('更新检查失败，旧版服务未保存成功检查结果；远端版本尚未确认。');
    expect(result.checkedAt).toBeNull();
    expect(result.error).not.toContain('github.com');
    expect(result.error).not.toContain('private token');
  });

  it('keeps updater-unavailable guidance without treating it as a repository check failure', async () => {
    const service = new SystemUpdateService({} as never);
    vi.spyOn(service as never, 'call').mockResolvedValue({
      ...status,
      updaterAvailable: false,
      error: '更新服务未运行；本地开发环境可忽略此提示。',
    });

    const result = await service.status();

    expect(result.error).toBe('更新服务未运行；本地开发环境可忽略此提示。');
    expect(result.checkErrorCode).toBeUndefined();
  });

  it('persists auto-update settings through the updater socket rather than the application database', async () => {
    const service = new SystemUpdateService({} as never);
    const call = vi.spyOn(service as never, 'call').mockResolvedValue({
      available: true,
      enabled: true,
      intervalHours: 6,
      lastCheckAt: null,
      nextCheckAt: '2026-11-02T16:00:00.000Z',
      lastCheckResult: 'scheduled',
      lastCheckErrorCode: null,
      lastUpdateAt: null,
      lastUpdateResult: 'never',
      lastUpdateError: null,
    });

    const result = await service.saveAutoUpdate({ enabled: true, intervalHours: 6 });

    expect(result).toMatchObject({ enabled: true, intervalHours: 6 });
    expect(call).toHaveBeenCalledWith('POST', '/auto-update', {
      enabled: true,
      intervalHours: 6,
    });
  });

  it('returns a safe unavailable status when the updater socket cannot be reached', async () => {
    const service = new SystemUpdateService({} as never);
    vi.spyOn(service as never, 'call').mockRejectedValue(new ServiceUnavailableException());

    await expect(service.status()).resolves.toMatchObject({
      updaterAvailable: false,
      updateAvailable: false,
      error: expect.any(String),
    });
  });
});
