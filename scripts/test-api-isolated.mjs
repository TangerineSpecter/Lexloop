#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(rootDir, 'apps/api');
const pgImage = 'pgvector/pgvector:pg16';
const redisImage = 'redis:7-alpine';
const id = `${process.pid}-${randomUUID().slice(0, 8)}`;
const pgName = `lexloop-api-test-${id}-pg`;
const redisName = `lexloop-api-test-${id}-redis`;
const containers = [];
let activeChild;
let interruptedBy;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interruptedBy = signal;
    activeChild?.kill(signal);
  });
}

function execute(command, args, { cwd = rootDir, env = process.env, capture = false } = {}) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (error) {
      resolveResult({ error, status: null, signal: null, stdout: '', stderr: '' });
      return;
    }

    activeChild = child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      resolveResult(result);
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!capture) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!capture) process.stderr.write(chunk);
    });
    child.once('error', (error) => finish({ error, status: null, signal: null, stdout, stderr }));
    child.once('close', (status, signal) => finish({ status, signal, stdout, stderr }));
  });
}

async function run(command, args, label, options = {}) {
  if (interruptedBy) throw new Error(`Interrupted by ${interruptedBy}.`);
  const result = await execute(command, args, options);
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `${label} failed${result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}${detail ? `: ${detail}` : '.'}`,
    );
  }
  return result.stdout.trim();
}

function getPublishedPort(output, label) {
  const line = output.split(/\r?\n/).find(Boolean);
  const match = line?.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error(`Could not determine the isolated ${label} host port.`);
  return Number(match[1]);
}

async function waitForContainer(name, checkArgs, label) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (interruptedBy) throw new Error(`Interrupted by ${interruptedBy}.`);
    const result = await execute('docker', ['exec', name, ...checkArgs], { capture: true });
    if (result.status === 0) return;
    await delay(500);
  }
  throw new Error(`${label} did not become ready within 45 seconds.`);
}

function cleanupContainers() {
  let failed = false;
  for (const name of containers) {
    const result = spawnSync('docker', ['rm', '--force', name], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.error || (result.status !== 0 && !/no such container/i.test(detail))) {
      failed = true;
      process.stderr.write(`Could not remove temporary test container ${name}.\n`);
    }
  }
  return !failed;
}

function parseTestSummary(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const match = clean.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s+\((\d+)\)/i);
  if (!match) return null;
  return { passed: Number(match[1]), skipped: Number(match[2] ?? 0), total: Number(match[3]) };
}

async function main() {
  const dockerVersion = await run(
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    'Docker engine check (Docker is required for isolated API integration tests)',
    { capture: true },
  );
  if (!dockerVersion) throw new Error('Docker engine returned no server version.');

  const pgPassword = randomBytes(24).toString('hex');
  containers.push(pgName);
  await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      pgName,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_DB=lexloop_test',
      '--env',
      'POSTGRES_USER=lexloop_test',
      '--env',
      `POSTGRES_PASSWORD=${pgPassword}`,
      pgImage,
    ],
    'Starting the temporary PostgreSQL container',
    { capture: true },
  );
  containers.push(redisName);
  await run(
    'docker',
    ['run', '--detach', '--rm', '--name', redisName, '--publish', '127.0.0.1::6379', redisImage],
    'Starting the temporary Redis container',
    { capture: true },
  );

  const pgPort = getPublishedPort(
    await run('docker', ['port', pgName, '5432/tcp'], 'Reading PostgreSQL test port', {
      capture: true,
    }),
    'PostgreSQL',
  );
  const redisPort = getPublishedPort(
    await run('docker', ['port', redisName, '6379/tcp'], 'Reading Redis test port', {
      capture: true,
    }),
    'Redis',
  );
  const databaseUrl = `postgresql://lexloop_test:${pgPassword}@127.0.0.1:${pgPort}/lexloop_test?schema=public`;
  const redisUrl = `redis://127.0.0.1:${redisPort}/2`;
  const testEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    LAB_TEST_DATABASE_URL: databaseUrl,
    PRACTICE_TEST_DATABASE_URL: databaseUrl,
    PRACTICE_TEST_REDIS_URL: redisUrl,
    FORCE_COLOR: '0',
  };

  process.stdout.write(
    `Using throwaway loopback services (PostgreSQL :${pgPort}, Redis :${redisPort}); no existing database URLs will be used.\n`,
  );
  await waitForContainer(
    pgName,
    ['pg_isready', '-U', 'lexloop_test', '-d', 'lexloop_test'],
    'Temporary PostgreSQL',
  );
  await waitForContainer(redisName, ['redis-cli', 'ping'], 'Temporary Redis');

  await run(
    resolve(apiDir, 'node_modules/.bin/prisma'),
    ['generate', '--schema', 'prisma/schema.prisma'],
    'Generating the API Prisma Client',
    { cwd: apiDir, env: testEnv },
  );

  await run(
    resolve(apiDir, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    'Applying API migrations to the temporary database',
    { cwd: apiDir, env: testEnv },
  );

  const testResult = await execute(resolve(apiDir, 'node_modules/.bin/vitest'), ['run'], {
    cwd: apiDir,
    env: testEnv,
  });
  if (testResult.error) throw new Error(`Starting Vitest failed: ${testResult.error.message}`);
  if (testResult.status !== 0) {
    throw new Error(
      `API suite failed${testResult.signal ? ` (${testResult.signal})` : ` (exit ${testResult.status})`}.`,
    );
  }

  const summary = parseTestSummary(testResult.stdout + testResult.stderr);
  if (!summary) {
    throw new Error('Vitest exited successfully, but its test summary could not be verified.');
  }
  if (summary.skipped > 0 || summary.passed !== summary.total) {
    throw new Error(
      `API suite incomplete: ${summary.passed}/${summary.total} passed, ${summary.skipped} skipped.`,
    );
  }
  process.stdout.write(
    `Verified complete API suite: ${summary.passed}/${summary.total} passed, 0 skipped.\n`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nFull API test entry failed: ${message}\n`);
  process.exitCode = interruptedBy === 'SIGINT' ? 130 : 1;
} finally {
  const createdContainers = containers.length > 0;
  const cleaned = cleanupContainers();
  if (cleaned && createdContainers) {
    process.stdout.write('Temporary PostgreSQL and Redis containers removed.\n');
  } else if (!cleaned) {
    process.exitCode = 1;
  }
}
