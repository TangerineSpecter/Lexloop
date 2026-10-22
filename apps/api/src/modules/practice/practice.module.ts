import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminModule } from '../admin/admin.module';
import { MistakesModule } from '../mistakes/mistakes.module';
import { PracticeController } from './practice.controller';
import { OutputService } from './output.service';
import { ConfusionService } from './confusion.service';
import { WeeklyService } from './weekly.service';
import { PracticeEvidenceService } from './practice-evidence.service';

@Module({
  imports: [
    PrismaModule,
    AdminModule,
    MistakesModule,
    BullModule.registerQueue({ name: 'practice-output' }),
  ],
  controllers: [PracticeController],
  providers: [OutputService, ConfusionService, WeeklyService, PracticeEvidenceService],
})
export class PracticeModule {}
