import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { SystemBackupController } from '../src/modules/admin/system-backup.controller';
import { BackupSettingsDto } from '../src/modules/admin/system-backup.dto';
import { SystemUpdateService } from '../src/modules/admin/system-update.service';
import { RolesGuard } from '../src/modules/auth/roles.guard';

describe('remote backup administration', () => {
  it('requires ADMIN on every backup endpoint', () => {
    const guard = new RolesGuard(new Reflector());
    for (const method of ['status', 'save', 'run'] as const) {
      const context = (role: Role | undefined) => ({
        getClass: () => SystemBackupController,
        getHandler: () => SystemBackupController.prototype[method],
        switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
      });
      expect(() => guard.canActivate(context(Role.USER) as never)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context(undefined) as never)).toThrow(ForbiddenException);
      expect(guard.canActivate(context(Role.ADMIN) as never)).toBe(true);
    }
  });

  it('checks the administrator password before sending secrets or starting backups', async () => {
    const auth = { verifyPassword: vi.fn().mockRejectedValue(new UnauthorizedException()) };
    const service = new SystemUpdateService(auth as never);
    const call = vi.spyOn(service as never, 'call');
    await expect(
      service.saveBackup('admin', { password: 'wrong-password', resetConfig: true } as never),
    ).rejects.toThrow(UnauthorizedException);
    await expect(service.runBackup('admin', 'wrong-password')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('does not forward the administrator password to the operations service', async () => {
    const auth = { verifyPassword: vi.fn().mockResolvedValue(undefined) };
    const service = new SystemUpdateService(auth as never);
    const call = vi.spyOn(service as never, 'call').mockResolvedValue({ available: true });
    await service.saveBackup('admin', {
      password: 'admin-password',
      host: 'nas.example.com',
      resetConfig: true,
    } as never);
    expect(call).toHaveBeenCalledWith('POST', '/backups/config', {
      host: 'nas.example.com',
      resetConfig: true,
    });
    await service.runBackup('admin', 'admin-password');
    expect(call).toHaveBeenLastCalledWith('POST', '/backups/run');
  });

  it('rejects invalid SFTP ports and batch command injection', async () => {
    const dto = Object.assign(new BackupSettingsDto(), {
      password: 'password',
      enabled: true,
      host: 'nas.example.com',
      port: 22,
      username: 'backup',
      remotePath: '/backups/lexloop',
      hostKey: 'ssh-ed25519 AAAA',
    });
    expect(await validate(dto)).toHaveLength(0);
    const invalidReset = Object.assign(new BackupSettingsDto(), dto, { resetConfig: 'true' });
    expect((await validate(invalidReset)).map((error) => error.property)).toContain('resetConfig');
    dto.remotePath = '/backups\nrm /other';
    dto.port = 70000;
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['port', 'remotePath']),
    );
  });
});
