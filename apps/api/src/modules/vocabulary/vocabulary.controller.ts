import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VocabularyService } from './vocabulary.service';

type AuthenticatedRequest = { user: { sub: string } };

class UpdateNewWordCountDto {
  @IsInt() @Min(5) @Max(40) defaultNewWordCount!: number;
}

@ApiTags('vocabulary')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vocabulary')
export class VocabularyController {
  constructor(private readonly vocabulary: VocabularyService) {}

  @Get('system') system(@Req() request: AuthenticatedRequest, @Query('category') category?: string) { return this.vocabulary.listSystemBooks(request.user.sub, category); }
  @Get('learning') learning(@Req() request: AuthenticatedRequest) { return this.vocabulary.listLearningBooks(request.user.sub); }
  @Get('default') defaultBook(@Req() request: AuthenticatedRequest) { return this.vocabulary.getDefaultBook(request.user.sub); }
  @Get('progress-summary') progressSummary(@Req() request: AuthenticatedRequest) { return this.vocabulary.getProgressSummary(request.user.sub); }
  @Delete('learning-records') clearLearningRecords(@Req() request: AuthenticatedRequest) { return this.vocabulary.clearLearningRecords(request.user.sub); }
  @Get('mastered') mastered(@Req() request: AuthenticatedRequest) { return this.vocabulary.listMasteredWords(request.user.sub); }
  @Delete('mastered/:wordId') removeMastered(@Req() request: AuthenticatedRequest, @Param('wordId') wordId: string) { return this.vocabulary.removeMasteredWord(request.user.sub, wordId); }
  @Get('learning-words') learningWords(@Req() request: AuthenticatedRequest) { return this.vocabulary.listLearningWords(request.user.sub); }
  @Get('dashboard-words') dashboardWords(@Req() request: AuthenticatedRequest, @Query('newWordCount') newWordCount?: string) { return this.vocabulary.getDashboardWords(request.user.sub, newWordCount); }
  @Patch('dashboard-settings') updateDashboardSettings(@Req() request: AuthenticatedRequest, @Body() dto: UpdateNewWordCountDto) { return this.vocabulary.updateDefaultNewWordCount(request.user.sub, dto.defaultNewWordCount); }
  @Post('words/:bookWordId/review') addToReview(@Req() request: AuthenticatedRequest, @Param('bookWordId') bookWordId: string) { return this.vocabulary.addToReview(request.user.sub, bookWordId); }
  @Post('words/:bookWordId/master') markMastered(@Req() request: AuthenticatedRequest, @Param('bookWordId') bookWordId: string) { return this.vocabulary.markMastered(request.user.sub, bookWordId); }
  @Post('words/:bookWordId/defer') deferNewWord(@Req() request: AuthenticatedRequest, @Param('bookWordId') bookWordId: string) { return this.vocabulary.deferNewWord(request.user.sub, bookWordId); }
  @Post('words/:bookWordId/defer-review') deferReview(@Req() request: AuthenticatedRequest, @Param('bookWordId') bookWordId: string) { return this.vocabulary.deferReview(request.user.sub, bookWordId); }
  @Post('books/:bookId/start') start(@Req() request: AuthenticatedRequest, @Param('bookId') bookId: string) { return this.vocabulary.activateBook(request.user.sub, bookId); }
  @Post('books/:bookId/continue') continue(@Req() request: AuthenticatedRequest, @Param('bookId') bookId: string) { return this.vocabulary.activateBook(request.user.sub, bookId); }
}
