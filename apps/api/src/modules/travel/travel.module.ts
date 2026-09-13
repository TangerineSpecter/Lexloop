import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { TravelController } from './travel.controller';
import { TravelSeedService } from './travel-seed.service';
import { TravelService } from './travel.service';

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [TravelController],
  providers: [TravelService, TravelSeedService],
})
export class TravelModule {}
