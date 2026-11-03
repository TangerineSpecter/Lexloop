import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { MiniMaxTtsClient } from './minimax-tts.client';
import { TtsAdminController } from './tts-admin.controller';
import { TtsController } from './tts.controller';
import { TtsAudioStore } from './tts-audio-store';
import { TtsConfigService } from './tts-config.service';
import { TtsService } from './tts.service';

@Module({
  imports: [AuthModule, PrismaModule, AdminModule],
  controllers: [TtsController, TtsAdminController],
  providers: [TtsConfigService, MiniMaxTtsClient, TtsAudioStore, TtsService],
})
export class TtsModule {}
