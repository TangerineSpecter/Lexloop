import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MistakesController } from './mistakes.controller';
import { MistakesService } from './mistakes.service';

@Module({
  imports: [PrismaModule],
  controllers: [MistakesController],
  providers: [MistakesService],
  exports: [MistakesService],
})
export class MistakesModule {}
