import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DAILY_SENTENCE_QUEUE } from './daily-sentence.rules';
import { DailySentenceService } from './daily-sentence.service';
import { HistoryQuery, UpdateSentenceDto } from './daily-sentence.dto';
type AuthRequest = { user: { sub: string } };

@ApiTags('daily-sentence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('daily-sentences')
export class DailySentenceController {
  constructor(private readonly sentences: DailySentenceService, @InjectQueue(DAILY_SENTENCE_QUEUE) private readonly queue: Queue) {}
  @Get('current') current(@Req() req: AuthRequest) { return this.sentences.current(req.user.sub); }
  @Get() history(@Req() req: AuthRequest, @Query() query: HistoryQuery) { return this.sentences.history(req.user.sub, query.page, query.favorites === 'true'); }
  @Post('retry') async retry(@Req() req: AuthRequest) {
    const dateKey = await this.sentences.retryable(req.user.sub);
    await this.queue.add('generate', { userId: req.user.sub, dateKey }, { jobId: `retry-${dateKey}-${req.user.sub}`, attempts: 1, removeOnComplete: true, removeOnFail: true });
    return { queued: true };
  }
  @Get(':id') detail(@Req() req: AuthRequest, @Param('id') id: string) { return this.sentences.detail(req.user.sub, id); }
  @Post(':id/read') read(@Req() req: AuthRequest, @Param('id') id: string) { return this.sentences.read(req.user.sub, id); }
  @Patch(':id') update(@Req() req: AuthRequest, @Param('id') id: string, @Body() dto: UpdateSentenceDto) { return this.sentences.update(req.user.sub, id, dto); }
}
