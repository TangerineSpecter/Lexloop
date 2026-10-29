import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiModule } from '../ai/ai.module';
import { DailySentenceService } from './daily-sentence.service';
import { DailySentenceController } from './daily-sentence.controller';
import { DAILY_SENTENCE_QUEUE } from './daily-sentence.rules';
import { DailySentenceSettingsService } from './daily-sentence-settings.service';
import { DailySentenceSettingsController } from './daily-sentence-settings.controller';

@Module({
  imports: [AiModule, BullModule.registerQueue({ name: DAILY_SENTENCE_QUEUE })],
  controllers: [DailySentenceController, DailySentenceSettingsController],
  providers: [DailySentenceService, DailySentenceSettingsService],
})
export class DailySentenceModule {}
