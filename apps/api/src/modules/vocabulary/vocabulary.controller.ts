import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VocabularyService } from './vocabulary.service';

type AuthenticatedRequest = { user: { sub: string } };

@ApiTags('vocabulary')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vocabulary')
export class VocabularyController {
  constructor(private readonly vocabulary: VocabularyService) {}

  @Get('system') system(@Req() request: AuthenticatedRequest, @Query('category') category?: string) { return this.vocabulary.listSystemBooks(request.user.sub, category); }
  @Get('learning') learning(@Req() request: AuthenticatedRequest) { return this.vocabulary.listLearningBooks(request.user.sub); }
  @Get('default') defaultBook(@Req() request: AuthenticatedRequest) { return this.vocabulary.getDefaultBook(request.user.sub); }
  @Post('books/:bookId/start') start(@Req() request: AuthenticatedRequest, @Param('bookId') bookId: string) { return this.vocabulary.activateBook(request.user.sub, bookId); }
  @Post('books/:bookId/continue') continue(@Req() request: AuthenticatedRequest, @Param('bookId') bookId: string) { return this.vocabulary.activateBook(request.user.sub, bookId); }
}
