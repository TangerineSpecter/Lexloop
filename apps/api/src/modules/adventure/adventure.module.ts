import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { MistakesModule } from '../mistakes/mistakes.module';
import { AdventureController } from './adventure.controller';
import { AdventureService } from './adventure.service';

@Module({ imports: [PrismaModule, MistakesModule, AiModule], controllers: [AdventureController], providers: [AdventureService] })
export class AdventureModule {}
