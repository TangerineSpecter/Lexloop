import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemUpdateService } from '../src/modules/admin/system-update.service';

describe('SystemUpdateService', () => {
  const auth = { verifyPassword: vi.fn() };
  let service: SystemUpdateService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new SystemUpdateService(auth as never);
  });

  it('does not forward an update when password verification fails', async () => {
    auth.verifyPassword.mockRejectedValue(new UnauthorizedException());
    const call = vi.spyOn(service as never, 'call');

    await expect(
      service.apply(
        { sub: 'admin-1', email: 'admin@example.com' },
        { targetVersion: '1.1.0', targetSha: 'a'.repeat(40), password: 'wrong-password' },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(call).not.toHaveBeenCalled();
  });

  it('forwards only the validated target and actor metadata to the updater', async () => {
    auth.verifyPassword.mockResolvedValue(true);
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

  it('returns a safe unavailable status when the updater socket cannot be reached', async () => {
    vi.spyOn(service as never, 'call').mockRejectedValue(new ServiceUnavailableException());

    await expect(service.status()).resolves.toMatchObject({
      updaterAvailable: false,
      updateAvailable: false,
      error: expect.any(String),
    });
  });
});
