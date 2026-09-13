import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StudyController } from './study.controller';
import { StudyService } from './study.service';
import { AiModule } from '../ai/ai.module';
import { AdminModule } from '../admin/admin.module';
import { MistakesModule } from '../mistakes/mistakes.module';

@Module({ imports: [PrismaModule, AiModule, AdminModule, MistakesModule], controllers: [StudyController], providers: [StudyService] })
export class StudyModule {}
