import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import Joi from 'joi';
import { AiModule } from './modules/ai/ai.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContentModule } from './modules/content/content.module';
import { HealthModule } from './modules/health/health.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MistakesModule } from './modules/mistakes/mistakes.module';
import { RagModule } from './modules/rag/rag.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StudyModule } from './modules/study/study.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: [resolve(process.cwd(), '../../.env'), '.env'], validationSchema: Joi.object({ DATABASE_URL: Joi.string().required(), REDIS_URL: Joi.string().required(), JWT_ACCESS_SECRET: Joi.string().min(24).required(), JWT_REFRESH_SECRET: Joi.string().min(24).required() }) }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    BullModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ connection: { url: config.getOrThrow<string>('REDIS_URL') } }) }),
    PrismaModule, AuthModule, AdminModule, HealthModule, JobsModule, StudyModule, ContentModule, MistakesModule, ReportsModule, AiModule, RagModule,
  ],
})
export class AppModule {}
