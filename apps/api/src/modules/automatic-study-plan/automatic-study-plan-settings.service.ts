import { BadRequestException, Injectable } from '@nestjs/common';
import { AutomaticStudyPlanRunStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS,
  AUTOMATIC_STUDY_PLAN_DEFAULT_TIME,
  AUTOMATIC_STUDY_PLAN_TIME_ZONE,
  automaticStudyPlanClock,
  isValidAutomaticStudyPlanTime,
} from './automatic-study-plan.rules';

const SETTING_KEY = 'automatic-study-plan';

@Injectable()
export class AutomaticStudyPlanSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig() {
    const setting = await this.prisma.systemFeatureSetting.findUnique({
      where: { key: SETTING_KEY },
      select: { enabled: true, scheduleTime: true },
    });
    return {
      enabled: setting?.enabled ?? false,
      scheduleTime: setting?.scheduleTime ?? AUTOMATIC_STUDY_PLAN_DEFAULT_TIME,
    };
  }

  async get() {
    const config = await this.getConfig();
    const clock = automaticStudyPlanClock(new Date(), config.scheduleTime);
    const grouped = await this.prisma.automaticStudyPlanRun.groupBy({
      by: ['status'],
      where: { dateKey: clock.dateKey },
      _count: { _all: true },
    });
    const groupedReasons = await this.prisma.automaticStudyPlanRun.groupBy({
      by: ['reasonCode'],
      where: {
        dateKey: clock.dateKey,
        status: { in: [AutomaticStudyPlanRunStatus.SKIPPED, AutomaticStudyPlanRunStatus.FAILED] },
        reasonCode: { not: null },
      },
      _count: { _all: true },
    });
    const today = Object.fromEntries(
      Object.values(AutomaticStudyPlanRunStatus).map((status) => [status, 0]),
    ) as Record<AutomaticStudyPlanRunStatus, number>;
    for (const row of grouped) today[row.status] = row._count._all;
    return {
      ...config,
      timeZone: AUTOMATIC_STUDY_PLAN_TIME_ZONE,
      today: { dateKey: clock.dateKey, ...today },
      reasons: Object.fromEntries(groupedReasons.map((row) => [row.reasonCode!, row._count._all])),
    };
  }

  async set(input: { enabled: boolean; scheduleTime: string }) {
    if (typeof input.enabled !== 'boolean') throw new BadRequestException('启用状态无效');
    if (!isValidAutomaticStudyPlanTime(input.scheduleTime)) {
      throw new BadRequestException('执行时间请使用 24 小时制 HH:mm，例如 06:30');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.systemFeatureSetting.upsert({
        where: { key: SETTING_KEY },
        create: { key: SETTING_KEY, enabled: input.enabled, scheduleTime: input.scheduleTime },
        update: { enabled: input.enabled, scheduleTime: input.scheduleTime },
      });
      if (!input.enabled) {
        await tx.automaticStudyPlanRun.updateMany({
          where: {
            status: { in: ['QUEUED', 'FAILED'] },
            attempts: { lt: AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS },
          },
          data: {
            status: 'SKIPPED',
            reasonCode: 'DISABLED',
            nextAttemptAt: null,
          },
        });
      }
    });
    return this.get();
  }
}
