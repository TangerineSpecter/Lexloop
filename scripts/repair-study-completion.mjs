#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (!['scan', 'preview', 'apply'].includes(command))
    throw new Error('Use scan, preview or apply; DATABASE_URL is never selected implicitly.');
  const options = {};
  const allowed = new Set([
    '--database-url-env',
    '--plan-id',
    '--out',
    '--manifest',
    '--confirm',
    '--after-id',
    '--limit',
  ]);
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !allowed.has(rest[i]) ||
      !rest[i + 1] ||
      rest[i + 1].startsWith('--') ||
      options[rest[i]] !== undefined
    )
      throw new Error('Invalid or duplicate option');
    options[rest[i]] = rest[i + 1];
  }
  const env = options['--database-url-env'];
  if (!env || !/^[A-Z][A-Z0-9_]*$/.test(env))
    throw new Error('Explicit --database-url-env is required');
  if (command === 'preview' && (!options['--plan-id'] || !options['--out']))
    throw new Error('preview requires --plan-id and --out');
  if (
    command === 'apply' &&
    (!options['--manifest'] || options['--confirm'] !== 'REPAIR_COMPLETION_METADATA')
  )
    throw new Error('apply requires a manifest and --confirm REPAIR_COMPLETION_METADATA');
  const limit = Number(options['--limit'] ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
  return { command, options, env, limit };
}
async function main() {
  const { command, options, env, limit } = parseArguments(process.argv.slice(2));
  const url = process.env[env];
  if (!url) throw new Error('The explicitly selected database environment variable is empty');
  const { PrismaClient } = require('../apps/api/node_modules/@prisma/client');
  const {
    StudyCompletionRepair,
  } = require('../apps/api/dist/modules/study/study-completion-repair.js');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const repair = new StudyCompletionRepair(db);
    if (command === 'scan')
      console.log(
        JSON.stringify({
          planIds: await repair.scan(limit, options['--after-id']),
          note: 'Read-only candidates, not verified eligibility; preview each ID. Continue using the last ID.',
        }),
      );
    if (command === 'preview') {
      const manifest = await repair.preview(options['--plan-id']);
      writeFileSync(options['--out'], JSON.stringify(manifest, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(
        JSON.stringify({ classification: manifest.classification, reasons: manifest.reasons }),
      );
    }
    if (command === 'apply')
      console.log(
        JSON.stringify(await repair.apply(JSON.parse(readFileSync(options['--manifest'], 'utf8')))),
      );
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    // Prisma connection failures may include endpoints; do not print raw errors.
    console.error(
      'Repair command failed or its outcome is unconfirmed. Check arguments, build/migration and preview freshness. For an apply attempt, inspect its receipt or retry the same manifest to confirm; no additional repair task was started.',
    );
    process.exitCode = 1;
  });
