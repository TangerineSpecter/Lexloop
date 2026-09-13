import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { AiModule } from '../ai/ai.module';

@Module({ imports: [PrismaModule, AiModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
