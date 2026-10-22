import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminModule } from '../admin/admin.module';
import { LabService } from './lab.service';
import { LabController } from './lab.controller';

@Module({
  imports: [PrismaModule, AdminModule, BullModule.registerQueue({ name: 'learning-lab' })],
  controllers: [LabController],
  providers: [LabService],
})
export class LabModule {}
