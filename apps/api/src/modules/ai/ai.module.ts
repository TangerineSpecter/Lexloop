import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AdminModule } from '../admin/admin.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TutorController } from './tutor.controller';
import { TutorService } from './tutor.service';
import { AiModelTestController } from './ai-model-test.controller';

@Module({
  imports: [AdminModule, PrismaModule],
  controllers: [AiController, TutorController, AiModelTestController],
  providers: [AiService, TutorService],
  exports: [AiService],
})
export class AiModule {}
