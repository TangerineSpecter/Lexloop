// A headless Nest context run by apps/worker. Reuses server-side AI configuration
// without starting HTTP, auth controllers, vocabulary seeds, or other API modules.
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { Job, Queue, Worker } from 'bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { AiService } from './modules/ai/ai.service';
import { AiModelConfigService } from './modules/admin/ai-model-config.service';
import { DailySentenceService } from './modules/daily-sentence/daily-sentence.service';
import { DailySentenceSettingsService } from './modules/daily-sentence/daily-sentence-settings.service';
import { DAILY_SENTENCE_QUEUE, dailySentenceClock } from './modules/daily-sentence/daily-sentence.rules';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: resolve(process.cwd(), '../../.env') }), PrismaModule],
  providers: [AiService, AiModelConfigService, DailySentenceService, DailySentenceSettingsService],
})
class DailySentenceWorkerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(DailySentenceWorkerModule);
  const sentences = app.get(DailySentenceService);
  const connection = { url: app.get(ConfigService).getOrThrow<string>('REDIS_URL') };
  const queue = new Queue(DAILY_SENTENCE_QUEUE, { connection });
  const sweep = async () => {
    await sentences.expireExhausted();
    const { dateKey, due } = dailySentenceClock(new Date());
    if (!due) return;
    let cursor: string | undefined;
    do {
      const users = await sentences.candidates(dateKey, cursor);
      for (const { id: userId } of users) await queue.add('generate', { userId, dateKey }, { jobId: `${dateKey}-${userId}`, attempts: 2, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true, removeOnFail: true });
      cursor = users.length === 200 ? users[users.length - 1].id : undefined;
    } while (cursor);
  };
  const worker = new Worker(DAILY_SENTENCE_QUEUE, async (job: Job) => {
    if (job.name === 'sweep') return sweep();
    if (job.name === 'generate') return sentences.generate(job.data.userId, job.data.dateKey);
    throw new Error('Unknown daily sentence job');
  }, { connection, concurrency: 3 });
  worker.on('failed', job => console.error(JSON.stringify({ event: 'daily-sentence.failed', jobId: job?.id })));
  worker.on('error', () => console.error('Daily sentence queue connection error'));
  // Five-minute checks recover downtime and interrupted reservations. The per-user
  // date and unread guards ensure only one successful sentence per day.
  await queue.upsertJobScheduler('daily-sentence-sweep', { every: 5 * 60_000 }, { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
  await queue.add('sweep', {}, { removeOnComplete: true, removeOnFail: 100 });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await worker.close(); await queue.close(); await app.close(); };
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
}

void bootstrap().catch(() => { console.error('Daily sentence worker startup failed'); process.exit(1); });
