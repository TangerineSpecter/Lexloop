import { BadRequestException, Injectable } from '@nestjs/common';
import { AutomaticStudyPlanRunStatus, StudyPlanPurpose, StudyPlanStatus } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AiModelConfigService } from '../admin/ai-model-config.service';
import { StudyService } from '../study/study.service';
import { AutomaticStudyPlanSettingsService } from './automatic-study-plan-settings.service';
import {
  AUTOMATIC_STUDY_PLAN_LEASE_MS,
  AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS,
  AUTOMATIC_STUDY_PLAN_RETRY_DELAY_MS,
  AUTOMATIC_STUDY_PLAN_QUEUE,
  automaticStudyPlanClock,
  chinaDateKey,
} from './automatic-study-plan.rules';

const USER_PAGE_SIZE = 200;
const RUN_RETENTION_DAYS = 90;

@Injectable()
export class AutomaticStudyPlanWorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AutomaticStudyPlanSettingsService,
    private readonly models: AiModelConfigService,
    private readonly study: StudyService,
  ) {}

  async sweep(queue: Queue, now = new Date()) {
    const config = await this.settings.getConfig();
    if (!config.enabled) return { queued: 0, dateKey: chinaDateKey(now), disabled: true };
    const clock = automaticStudyPlanClock(now, config.scheduleTime);
    if (!clock.due) return { queued: 0, dateKey: clock.dateKey, disabled: false };

    const staleBefore = new Date(now.getTime() - AUTOMATIC_STUDY_PLAN_LEASE_MS);
    await this.prisma.automaticStudyPlanRun.updateMany({
      where: {
        dateKey: clock.dateKey,
        status: AutomaticStudyPlanRunStatus.RUNNING,
        startedAt: { lt: staleBefore },
      },
      data: {
        status: AutomaticStudyPlanRunStatus.FAILED,
        reasonCode: 'WORKER_INTERRUPTED',
        nextAttemptAt: now,
      },
    });

    const retentionDate = chinaDateKey(new Date(now.getTime() - RUN_RETENTION_DAYS * 86_400_000));
    await this.prisma.automaticStudyPlanRun.deleteMany({
      where: {
        dateKey: { lt: retentionDate },
        status: { not: AutomaticStudyPlanRunStatus.RUNNING },
      },
    });

    let cursor: string | undefined;
    do {
      const users = await this.prisma.user.findMany({
        where: {
          ...(cursor ? { id: { gt: cursor } } : {}),
          automaticStudyPlanRuns: { none: { dateKey: clock.dateKey } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: USER_PAGE_SIZE,
      });
      if (users.length) {
        await this.prisma.automaticStudyPlanRun.createMany({
          data: users.map(({ id: userId }) => ({ userId, dateKey: clock.dateKey })),
          skipDuplicates: true,
        });
      }
      cursor = users.length === USER_PAGE_SIZE ? users[users.length - 1].id : undefined;
    } while (cursor);

    let readyCursor: string | undefined;
    let queued = 0;
    do {
      const ready = await this.prisma.automaticStudyPlanRun.findMany({
        where: {
          dateKey: clock.dateKey,
          attempts: { lt: AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS },
          ...(readyCursor ? { userId: { gt: readyCursor } } : {}),
          AND: [
            {
              status: {
                in: [AutomaticStudyPlanRunStatus.QUEUED, AutomaticStudyPlanRunStatus.FAILED],
              },
            },
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          ],
        },
        select: { userId: true, dateKey: true },
        orderBy: { userId: 'asc' },
        take: USER_PAGE_SIZE,
      });
      for (const run of ready) {
        await queue.add('generate', run, {
          jobId: `${run.dateKey}-${run.userId}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        });
      }
      queued += ready.length;
      readyCursor = ready.length === USER_PAGE_SIZE ? ready[ready.length - 1].userId : undefined;
    } while (readyCursor);
    return { queued, dateKey: clock.dateKey, disabled: false };
  }

  async process(userId: string, dateKey: string, now = new Date()) {
    const run = await this.prisma.automaticStudyPlanRun.findUnique({
      where: { userId_dateKey: { userId, dateKey } },
    });
    if (!run || isTerminal(run)) return;

    const config = await this.settings.getConfig();
    if (!config.enabled) return this.skip(run.id, 'DISABLED');
    const clock = automaticStudyPlanClock(now, config.scheduleTime);
    if (dateKey !== clock.dateKey) return this.skip(run.id, 'MISSED_DATE');
    if (!clock.due) {
      await this.prisma.automaticStudyPlanRun.updateMany({
        where: {
          id: run.id,
          status: { in: [AutomaticStudyPlanRunStatus.QUEUED, AutomaticStudyPlanRunStatus.FAILED] },
        },
        data: { status: AutomaticStudyPlanRunStatus.QUEUED, nextAttemptAt: clock.startsAt },
      });
      return;
    }

    const claim = await this.prisma.automaticStudyPlanRun.updateMany({
      where: {
        id: run.id,
        status: { in: [AutomaticStudyPlanRunStatus.QUEUED, AutomaticStudyPlanRunStatus.FAILED] },
        attempts: { lt: AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: AutomaticStudyPlanRunStatus.RUNNING,
        startedAt: now,
        nextAttemptAt: null,
        reasonCode: null,
      },
    });
    if (!claim.count) return;

    const automaticPlan = await this.prisma.studyPlan.findUnique({
      where: { userId_autoDateKey: { userId, autoDateKey: dateKey } },
      select: { id: true, status: true, generationStartedAt: true },
    });

    if (!automaticPlan) {
      const dateRange = automaticStudyPlanClock(now, config.scheduleTime);
      const previousAutomaticFailure = await this.prisma.studyPlan.findFirst({
        where: {
          userId,
          purpose: StudyPlanPurpose.NORMAL,
          status: StudyPlanStatus.FAILED,
          autoDateKey: { not: null, lt: dateKey },
          automaticStudyPlanRun: { is: { attempts: { gte: 1 } } },
        },
        select: { id: true },
        orderBy: { autoDateKey: 'desc' },
      });
      if (previousAutomaticFailure) return this.skip(run.id, 'PREVIOUS_AUTO_PLAN_FAILED');
      const unfinished = await this.prisma.studyPlan.findFirst({
        where: {
          userId,
          purpose: StudyPlanPurpose.NORMAL,
          OR: [
            { status: { in: [StudyPlanStatus.GENERATING, StudyPlanStatus.ACTIVE] } },
            {
              status: StudyPlanStatus.FAILED,
              createdAt: { gte: dateRange.dayStartsAt, lt: dateRange.nextDayStartsAt },
            },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      if (unfinished) return this.skip(run.id, 'PLAN_IN_PROGRESS');

      try {
        if (!(await this.models.selectedProvider(userId))) {
          return this.skip(run.id, 'MODEL_NOT_SELECTED');
        }
      } catch {
        return this.skip(run.id, 'MODEL_NOT_READY');
      }

      try {
        const created = await this.study.createPlan(
          userId,
          undefined,
          'group',
          undefined,
          undefined,
          undefined,
          dateKey,
        );
        const plan = await this.prisma.studyPlan.findUnique({
          where: { id: created.id },
          select: { id: true, autoDateKey: true, status: true, generationStartedAt: true },
        });
        if (!plan || plan.autoDateKey !== dateKey) return this.skip(run.id, 'PLAN_IN_PROGRESS');
        return this.attachAndGenerate(run.id, userId, dateKey, plan, now);
      } catch (error) {
        if (error instanceof BadRequestException) return this.skip(run.id, 'NO_ELIGIBLE_WORDS');
        return this.failNextAttempt(run.id, 'PLAN_CREATE_FAILED', now);
      }
    }

    if (
      automaticPlan.status === StudyPlanStatus.ACTIVE ||
      automaticPlan.status === StudyPlanStatus.COMPLETED
    ) {
      return this.markGenerated(run.id, automaticPlan.id);
    }
    try {
      if (!(await this.models.selectedProvider(userId))) {
        await this.failUnclaimedPlan(userId, dateKey, automaticPlan.id);
        return this.skip(run.id, 'MODEL_NOT_SELECTED');
      }
    } catch {
      await this.failUnclaimedPlan(userId, dateKey, automaticPlan.id);
      return this.skip(run.id, 'MODEL_NOT_READY');
    }
    return this.attachAndGenerate(run.id, userId, dateKey, automaticPlan, now);
  }

  private async attachAndGenerate(
    runId: string,
    userId: string,
    dateKey: string,
    plan: { id: string; status: StudyPlanStatus; generationStartedAt: Date | null },
    now: Date,
  ) {
    await this.prisma.automaticStudyPlanRun.updateMany({
      where: { id: runId, status: AutomaticStudyPlanRunStatus.RUNNING },
      data: { planId: plan.id },
    });

    if (plan.status === StudyPlanStatus.GENERATING && plan.generationStartedAt) {
      const retryAt = new Date(plan.generationStartedAt.getTime() + AUTOMATIC_STUDY_PLAN_LEASE_MS);
      if (retryAt > now) {
        await this.prisma.automaticStudyPlanRun.updateMany({
          where: { id: runId, status: AutomaticStudyPlanRunStatus.RUNNING },
          data: { status: AutomaticStudyPlanRunStatus.QUEUED, nextAttemptAt: retryAt },
        });
        return;
      }
    }

    const latestConfig = await this.settings.getConfig();
    if (!latestConfig.enabled) {
      if (!plan.generationStartedAt) {
        await this.failUnclaimedPlan(
          userId,
          dateKey,
          plan.id,
          '自动计划已关闭，尚未开始生成；可按现有手动流程继续。',
        );
      }
      return this.skip(runId, 'DISABLED');
    }

    const attempt = await this.prisma.automaticStudyPlanRun.updateMany({
      where: {
        id: runId,
        status: AutomaticStudyPlanRunStatus.RUNNING,
        attempts: { lt: AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (!attempt.count) return;
    try {
      const generated = await this.study.generatePlan(
        (await this.prisma.automaticStudyPlanRun.findUniqueOrThrow({ where: { id: runId } }))
          .userId,
        plan.id,
      );
      if (
        generated.status === StudyPlanStatus.ACTIVE ||
        generated.status === StudyPlanStatus.COMPLETED
      ) {
        return this.markGenerated(runId, plan.id);
      }
      const current = await this.prisma.automaticStudyPlanRun.findUniqueOrThrow({
        where: { id: runId },
      });
      return this.fail(runId, 'GENERATION_FAILED', current.attempts, now);
    } catch {
      const current = await this.prisma.automaticStudyPlanRun.findUniqueOrThrow({
        where: { id: runId },
      });
      return this.fail(runId, 'GENERATION_FAILED', current.attempts, now);
    }
  }

  private async markGenerated(runId: string, planId: string) {
    await this.prisma.automaticStudyPlanRun.updateMany({
      where: { id: runId, status: AutomaticStudyPlanRunStatus.RUNNING },
      data: {
        status: AutomaticStudyPlanRunStatus.GENERATED,
        planId,
        reasonCode: null,
        nextAttemptAt: null,
      },
    });
  }

  private async skip(runId: string, reasonCode: string) {
    await this.prisma.automaticStudyPlanRun.updateMany({
      where: {
        id: runId,
        status: {
          in: [
            AutomaticStudyPlanRunStatus.QUEUED,
            AutomaticStudyPlanRunStatus.RUNNING,
            AutomaticStudyPlanRunStatus.FAILED,
          ],
        },
      },
      data: {
        status: AutomaticStudyPlanRunStatus.SKIPPED,
        reasonCode,
        nextAttemptAt: null,
      },
    });
  }

  private async fail(runId: string, reasonCode: string, attempts: number, now: Date) {
    const retry = attempts < AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS;
    await this.prisma.automaticStudyPlanRun.updateMany({
      where: { id: runId, status: AutomaticStudyPlanRunStatus.RUNNING },
      data: {
        status: AutomaticStudyPlanRunStatus.FAILED,
        reasonCode,
        nextAttemptAt: retry ? new Date(now.getTime() + AUTOMATIC_STUDY_PLAN_RETRY_DELAY_MS) : null,
      },
    });
  }

  private async failNextAttempt(runId: string, reasonCode: string, now: Date) {
    const updated = await this.prisma.automaticStudyPlanRun.updateMany({
      where: { id: runId, status: AutomaticStudyPlanRunStatus.RUNNING },
      data: { attempts: { increment: 1 } },
    });
    if (!updated.count) return;
    const current = await this.prisma.automaticStudyPlanRun.findUniqueOrThrow({
      where: { id: runId },
    });
    return this.fail(runId, reasonCode, current.attempts, now);
  }

  private async failUnclaimedPlan(
    userId: string,
    dateKey: string,
    planId: string,
    message = '自动计划没有可用的已选模型，请在设置模型后重试。',
  ) {
    await this.prisma.studyPlan.updateMany({
      where: {
        id: planId,
        userId,
        autoDateKey: dateKey,
        status: StudyPlanStatus.GENERATING,
        generationStartedAt: null,
      },
      data: {
        status: StudyPlanStatus.FAILED,
        generationError: message,
      },
    });
  }
}

function isTerminal(run: { status: AutomaticStudyPlanRunStatus; attempts: number }) {
  return (
    run.status === AutomaticStudyPlanRunStatus.GENERATED ||
    run.status === AutomaticStudyPlanRunStatus.SKIPPED ||
    (run.status === AutomaticStudyPlanRunStatus.FAILED &&
      run.attempts >= AUTOMATIC_STUDY_PLAN_MAX_ATTEMPTS)
  );
}
