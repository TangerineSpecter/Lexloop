import { BullModule } from '@nestjs/bullmq';
import { Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiTags } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

@ApiTags('jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('jobs')
class JobsController {
  constructor(@InjectQueue('maintenance') private readonly queue: Queue) {}
  @Get('health') async health() { return { waiting: await this.queue.getWaitingCount(), active: await this.queue.getActiveCount() }; }
  @Post('example') async enqueue() { const job = await this.queue.add('example', { source: 'api' }); return { id: job.id, status: 'queued' }; }
}

@Module({ imports: [BullModule.registerQueue({ name: 'maintenance' })], controllers: [JobsController] })
export class JobsModule {}
