import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Job, Worker } from 'bullmq';
import { spawn } from 'node:child_process';

config({ path: resolve(process.cwd(), '../../.env') });
const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };

// Keep generation in the worker process group. The headless server entrypoint
// shares Prisma and the encrypted model adapter, and exposes no HTTP routes.
const apiRoot = resolve(__dirname, '../../api');
let shuttingDown = false;
const dailyWorker = spawn(process.execPath, process.env.NODE_ENV === 'production'
  ? [resolve(apiRoot, 'dist/daily-sentence-worker.js')]
  : ['-r', 'ts-node/register', 'src/daily-sentence-worker.ts'], { cwd: apiRoot, stdio: 'inherit' });
dailyWorker.on('error', () => { console.error('Unable to start daily sentence worker'); process.exit(1); });
dailyWorker.on('exit', code => { if (!shuttingDown) process.exit(code || 1); });

const worker = new Worker('maintenance', async (job: Job) => {
  // Report aggregation, RAG embedding, imports, and AI generation are added here as named jobs.
  console.info(JSON.stringify({ event: 'job.completed', id: job.id, name: job.name, at: new Date().toISOString() }));
  return { processed: true, name: job.name };
}, { connection });

worker.on('failed', (job, error) => console.error(JSON.stringify({ event: 'job.failed', id: job?.id, error: error.message })));
console.info('Lexloop worker is listening on queue: maintenance');

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  shuttingDown = true;
  dailyWorker.kill(signal);
  void worker.close();
});
