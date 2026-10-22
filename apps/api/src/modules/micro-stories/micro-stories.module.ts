import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MicroStoriesController } from './micro-stories.controller';
import { MicroStoriesService } from './micro-stories.service';

@Module({
  imports: [PrismaModule],
  controllers: [MicroStoriesController],
  providers: [MicroStoriesService],
})
export class MicroStoriesModule {}
