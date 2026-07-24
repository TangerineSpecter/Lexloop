import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StudyController } from './study.controller';
import { StudyService } from './study.service';
import { AiModule } from '../ai/ai.module';
import { AdminModule } from '../admin/admin.module';

@Module({ imports: [PrismaModule, AiModule, AdminModule], controllers: [StudyController], providers: [StudyService] })
export class StudyModule {}
