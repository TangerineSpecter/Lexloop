import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { VocabularyController } from './vocabulary.controller';
import { VocabularySeedService } from './vocabulary-seed.service';
import { VocabularyService } from './vocabulary.service';

@Module({ imports: [PrismaModule], controllers: [VocabularyController], providers: [VocabularyService, VocabularySeedService] })
export class VocabularyModule {}
