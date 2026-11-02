import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AutomaticStudyPlanRunStatus, Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../src/modules/auth/roles.decorator';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { AutomaticStudyPlanSettingsController } from '../src/modules/automatic-study-plan/automatic-study-plan-settings.controller';
import { AutomaticStudyPlanSettingsService } from '../src/modules/automatic-study-plan/automatic-study-plan-settings.service';

function harness() {
  let stored: { enabled: boolean; scheduleTime: string | null } | null = null;
  const prisma = {
    systemFeatureSetting: {
      findUnique: vi.fn(async () => stored),
      upsert: vi.fn(
        async ({ create, update }: { create: typeof stored; update: Partial<typeof stored> }) => {
          stored = { ...(stored ?? create!), ...update };
          return stored;
        },
      ),
    },
    automaticStudyPlanRun: {
      groupBy: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  return { prisma, settings: new AutomaticStudyPlanSettingsService(prisma as never) };
}

describe('automatic study plan settings', () => {
  it('protects settings reads and writes with JWT and ADMIN guards', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AutomaticStudyPlanSettingsController)).toEqual([
      Role.ADMIN,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AutomaticStudyPlanSettingsController)).toHaveLength(
      2,
    );
    const guard = new RolesGuard(new Reflector());
    for (const method of ['get', 'set'] as const) {
      const context = (role: Role | undefined) => ({
        getClass: () => AutomaticStudyPlanSettingsController,
        getHandler: () => AutomaticStudyPlanSettingsController.prototype[method],
        switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
      });
      expect(() => guard.canActivate(context(Role.USER) as never)).toThrow();
      expect(() => guard.canActivate(context(undefined) as never)).toThrow();
      expect(guard.canActivate(context(Role.ADMIN) as never)).toBe(true);
    }
  });

  it('defaults to disabled at 06:30 China time and reports current-day aggregate counts only', async () => {
    const { prisma, settings } = harness();
    prisma.automaticStudyPlanRun.groupBy.mockResolvedValueOnce([
      { status: AutomaticStudyPlanRunStatus.GENERATED, _count: { _all: 2 } },
      { status: AutomaticStudyPlanRunStatus.SKIPPED, _count: { _all: 1 } },
    ] as never);
    prisma.automaticStudyPlanRun.groupBy.mockResolvedValueOnce([
      { reasonCode: 'NO_ELIGIBLE_WORDS', _count: { _all: 1 } },
    ] as never);

    await expect(settings.get()).resolves.toMatchObject({
      enabled: false,
      scheduleTime: '06:30',
      timeZone: 'Asia/Shanghai',
      today: { GENERATED: 2, SKIPPED: 1, RUNNING: 0, QUEUED: 0, FAILED: 0 },
      reasons: { NO_ELIGIBLE_WORDS: 1 },
    });
    expect(prisma.automaticStudyPlanRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dateKey: expect.any(String) } }),
    );
  });

  it('validates schedule values and persists the global setting', async () => {
    const { prisma, settings } = harness();
    await expect(settings.set({ enabled: true, scheduleTime: '24:00' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await settings.set({ enabled: true, scheduleTime: '07:15' });
    expect(prisma.systemFeatureSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'automatic-study-plan' },
      create: { key: 'automatic-study-plan', enabled: true, scheduleTime: '07:15' },
      update: { enabled: true, scheduleTime: '07:15' },
    });
  });

  it('turning off skips queued and retryable runs, not running or exhausted work', async () => {
    const { prisma, settings } = harness();
    const updateMany = prisma.automaticStudyPlanRun.updateMany;
    await settings.set({ enabled: false, scheduleTime: '06:30' });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['QUEUED', 'FAILED'] },
        attempts: { lt: 2 },
      },
      data: { status: 'SKIPPED', reasonCode: 'DISABLED', nextAttemptAt: null },
    });
  });
});
