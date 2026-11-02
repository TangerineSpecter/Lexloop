// A headless Nest context run by apps/worker. Reuses server-side AI configuration
// without starting HTTP, auth controllers, vocabulary seeds, or other API modules.
import 'reflect-metadata';
import { LabService } from './modules/learning-lab/lab.service';
import { generateLab } from './modules/learning-lab/lab.processor';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { Job, Queue, Worker } from 'bullmq';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { AiService } from './modules/ai/ai.service';
import { AiModelConfigService } from './modules/admin/ai-model-config.service';
import { DailySentenceService } from './modules/daily-sentence/daily-sentence.service';
import { DailySentenceSettingsService } from './modules/daily-sentence/daily-sentence-settings.service';
import {
  DAILY_SENTENCE_QUEUE,
  dailySentenceClock,
} from './modules/daily-sentence/daily-sentence.rules';
import { OutputService } from './modules/practice/output.service';
import { PracticeEvidenceService } from './modules/practice/practice-evidence.service';
import { MistakesService } from './modules/mistakes/mistakes.service';
import { StudyService } from './modules/study/study.service';
import { AutomaticStudyPlanSettingsService } from './modules/automatic-study-plan/automatic-study-plan-settings.service';
import { AutomaticStudyPlanWorkerService } from './modules/automatic-study-plan/automatic-study-plan.worker-service';
import { AUTOMATIC_STUDY_PLAN_QUEUE } from './modules/automatic-study-plan/automatic-study-plan.rules';
import { gradeOutput } from './modules/practice/output.processor';
import { appendSystemLogEvent } from './modules/admin/system-log-file';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: resolve(process.cwd(), '../../.env') }),
    PrismaModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
      }),
    }),
    BullModule.registerQueue(
      { name: 'practice-output' },
      { name: 'learning-lab' },
      { name: AUTOMATIC_STUDY_PLAN_QUEUE },
    ),
  ],
  providers: [
    AiService,
    AiModelConfigService,
    DailySentenceService,
    DailySentenceSettingsService,
    OutputService,
    LabService,
    PracticeEvidenceService,
    MistakesService,
    StudyService,
    AutomaticStudyPlanSettingsService,
    AutomaticStudyPlanWorkerService,
  ],
})
class DailySentenceWorkerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(DailySentenceWorkerModule);
  const sentences = app.get(DailySentenceService);
  const automaticPlans = app.get(AutomaticStudyPlanWorkerService);
  const connection = { url: app.get(ConfigService).getOrThrow<string>('REDIS_URL') };
  const queue = new Queue(DAILY_SENTENCE_QUEUE, { connection });
  const automaticPlanQueue = new Queue(AUTOMATIC_STUDY_PLAN_QUEUE, { connection });
  const sweep = async () => {
    await sentences.expireExhausted();
    const { dateKey, due } = dailySentenceClock(new Date());
    if (!due) return;
    let cursor: string | undefined;
    do {
      const users = await sentences.candidates(dateKey, cursor);
      for (const { id: userId } of users)
        await queue.add(
          'generate',
          { userId, dateKey },
          {
            jobId: `${dateKey}-${userId}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      cursor = users.length === 200 ? users[users.length - 1].id : undefined;
    } while (cursor);
  };
  const worker = new Worker(
    DAILY_SENTENCE_QUEUE,
    async (job: Job) => {
      if (job.name === 'sweep') return sweep();
      if (job.name === 'generate') return sentences.generate(job.data.userId, job.data.dateKey);
      throw new Error('Unknown daily sentence job');
    },
    { connection, concurrency: 3 },
  );
  const automaticPlanWorker = new Worker(
    AUTOMATIC_STUDY_PLAN_QUEUE,
    (job: Job) => {
      if (job.name === 'sweep') return automaticPlans.sweep(automaticPlanQueue);
      if (job.name === 'generate') {
        return automaticPlans.process(job.data.userId, job.data.dateKey);
      }
      throw new Error('Unknown automatic study plan job');
    },
    { connection, concurrency: 2, limiter: { max: 4, duration: 60_000 } },
  );
  automaticPlanWorker.on(
    'failed',
    (job) =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_failed',
        code: 'AUTOMATIC_STUDY_PLAN_FAILED',
        reason: '自动学习计划后台任务失败；用户内容和任务标识未记录。',
        phase: queueFailurePhase(job?.attemptsMade, job?.opts.attempts),
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
      }),
  );
  automaticPlanWorker.on(
    'error',
    () =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_error',
        code: 'AUTOMATIC_STUDY_PLAN_QUEUE_ERROR',
        reason: '自动学习计划队列连接发生错误；原始错误详情已隐藏。',
      }),
  );
  worker.on(
    'failed',
    (job) =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_failed',
        code: 'DAILY_SENTENCE_FAILED',
        reason: '每日内容后台任务失败；用户内容和任务标识未记录。',
        phase: queueFailurePhase(job?.attemptsMade, job?.opts.attempts),
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
      }),
  );
  worker.on(
    'error',
    () =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_error',
        code: 'DAILY_SENTENCE_QUEUE_ERROR',
        reason: '每日内容队列连接发生错误；原始错误详情已隐藏。',
      }),
  );
  const outputWorker = new Worker(
    'practice-output',
    (job) => gradeOutput(job, app.get(OutputService)),
    { connection, concurrency: 2, limiter: { max: 6, duration: 60_000 } },
  );
  outputWorker.on(
    'failed',
    (job) =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_failed',
        code: 'PRACTICE_OUTPUT_FAILED',
        reason: '输出批改后台任务失败；学习者输入和任务标识未记录。',
        phase: queueFailurePhase(job?.attemptsMade, job?.opts.attempts),
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
      }),
  );
  outputWorker.on(
    'error',
    () =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_error',
        code: 'PRACTICE_OUTPUT_QUEUE_ERROR',
        reason: '输出批改队列连接发生错误；原始错误详情已隐藏。',
      }),
  );
  const labWorker = new Worker('learning-lab', (job) => generateLab(job, app.get(LabService)), {
    connection,
    concurrency: 2,
    limiter: { max: 6, duration: 60_000 },
  });
  labWorker.on(
    'failed',
    (job) =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_failed',
        code: 'LEARNING_LAB_FAILED',
        reason: '精读语法后台任务失败；学习者输入和任务标识未记录。',
        phase: queueFailurePhase(job?.attemptsMade, job?.opts.attempts),
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
      }),
  );
  labWorker.on(
    'error',
    () =>
      void appendSystemLogEvent({
        source: 'worker',
        kind: 'worker.queue_error',
        code: 'LEARNING_LAB_QUEUE_ERROR',
        reason: '精读语法队列连接发生错误；原始错误详情已隐藏。',
      }),
  );
  // Five-minute checks recover downtime and interrupted reservations. The per-user
  // date and unread guards ensure only one successful sentence per day.
  await queue.upsertJobScheduler(
    'daily-sentence-sweep',
    { every: 5 * 60_000 },
    { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await queue.add('sweep', {}, { removeOnComplete: true, removeOnFail: 100 });
  await automaticPlanQueue.upsertJobScheduler(
    'automatic-study-plan-sweep',
    { every: 60_000 },
    { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await automaticPlanQueue.add('sweep', {}, { removeOnComplete: true, removeOnFail: 100 });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.all([
      worker.close(),
      outputWorker.close(),
      labWorker.close(),
      automaticPlanWorker.close(),
    ]);
    await Promise.all([queue.close(), automaticPlanQueue.close()]);
    await app.close();
  };
  process.once('SIGTERM', () => {
    void close();
  });
  process.once('SIGINT', () => {
    void close();
  });
}

void bootstrap().catch(() => {
  void appendSystemLogEvent({
    source: 'worker',
    kind: 'worker.startup_error',
    code: 'DAILY_WORKER_STARTUP_FAILED',
    reason: '后台任务服务启动失败；原始错误详情已隐藏。',
  });
  console.error('Daily sentence worker startup failed');
  process.exit(1);
});

function queueFailurePhase(attemptsMade?: number, maxAttempts?: number): string {
  return attemptsMade !== undefined && maxAttempts !== undefined && attemptsMade >= maxAttempts
    ? 'final'
    : 'retry';
}
