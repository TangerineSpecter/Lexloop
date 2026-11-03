import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { VocabularyController } from './vocabulary.controller';
import { VocabularySeedService } from './vocabulary-seed.service';
import { VocabularyService } from './vocabulary.service';
import { DailySupplementController } from './daily-supplement.controller';
import { DailySupplementService } from './daily-supplement.service';

@Module({
  imports: [PrismaModule],
  controllers: [VocabularyController, DailySupplementController],
  providers: [VocabularyService, VocabularySeedService, DailySupplementService],
})
export class VocabularyModule {}
