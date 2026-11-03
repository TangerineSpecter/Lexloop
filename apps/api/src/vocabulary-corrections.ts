import { PrismaClient } from '@prisma/client';
import { VocabularyCorrectionsService } from './modules/vocabulary/vocabulary-corrections.service';

// Explicit local operator command, not an HTTP endpoint or automatic startup hook.
export async function main(args = process.argv.slice(2)) {
  const [command = 'preview', token] = args;
  if (
    !['preview', 'apply', 'restore-preview', 'restore'].includes(command) ||
    args.length > 2 ||
    (command === 'apply' || command === 'restore' ? !token : !!token)
  )
    throw new Error(
      'Usage: node dist/vocabulary-corrections.js preview | apply <preview-token> | restore-preview | restore <preview-token>',
    );
  const prisma = new PrismaClient();
  try {
    const service = new VocabularyCorrectionsService(prisma);
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
