import { PrismaClient } from '@prisma/client';
import {
  VocabularyCorrectionsService,
  correctionBatch,
} from './modules/vocabulary/vocabulary-corrections.service';

// Explicit local operator command, not an HTTP endpoint or automatic startup hook.
export async function main(args = process.argv.slice(2)) {
  const batchIndex = args.indexOf('--batch');
  const requestedBatch = batchIndex < 0 ? undefined : args[batchIndex + 1];
  if (batchIndex >= 0 && (!requestedBatch || batchIndex !== args.length - 2))
    throw new Error('Invalid batch argument');
  const batch = correctionBatch(requestedBatch);
  const commands = batchIndex < 0 ? args : args.slice(0, batchIndex);
  const [command = 'preview', token] = commands;
  if (
    !['preview', 'apply', 'restore-preview', 'restore'].includes(command) ||
    commands.length > 2 ||
    (command === 'apply' || command === 'restore' ? !token : !!token)
  )
    throw new Error(
      'Usage: node dist/vocabulary-corrections.js preview | apply <preview-token> | restore-preview | restore <preview-token> [--batch <reviewed-batch-id>]',
    );
  const prisma = new PrismaClient();
  try {
    const service = new VocabularyCorrectionsService(prisma, batch);
    const result =
      command === 'preview'
        ? await service.preview()
        : command === 'restore-preview'
          ? await service.preview('restore')
          : await service.execute(command === 'apply' ? 'apply' : 'restore', token!);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module)
  main().catch(() => {
    // Never print Prisma connection errors (they may include credentials).
    console.error(
      'Vocabulary correction did not confirm completion. Check migrations and database availability, then run a fresh preview to inspect audit state before retrying.',
    );
    process.exitCode = 1;
  });
