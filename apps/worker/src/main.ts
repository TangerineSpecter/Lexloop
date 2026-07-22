import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Job, Worker } from 'bullmq';

config({ path: resolve(process.cwd(), '../../.env') });
const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };

const worker = new Worker('maintenance', async (job: Job) => {
  // Report aggregation, RAG embedding, imports, and AI generation are added here as named jobs.
  console.info(JSON.stringify({ event: 'job.completed', id: job.id, name: job.name, at: new Date().toISOString() }));
  return { processed: true, name: job.name };
}, { connection });

worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'job.failed', id: job?.id, error: error.message })));
console.info('Lexloop worker is listening on queue: maintenance');
