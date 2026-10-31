import { Type } from 'class-transformer';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CefrLevel, LexicalItemType } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VocabularyService } from './vocabulary.service';

type AuthenticatedRequest = { user: { sub: string } };

function archivePageOptions(pageSize?: string, cursor?: string) {
  if (pageSize === undefined && cursor === undefined) return undefined;
  const parsedSize =
    pageSize === undefined ? 50 : /^(?:[1-9]\d*)$/.test(pageSize) ? Number(pageSize) : NaN;
  if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > 100) {
    throw new BadRequestException('每页数量必须是 1 到 100 的整数');
  }
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512)) {
    throw new BadRequestException('词汇档案游标无效，请重新加载');
  }
  return { pageSize: parsedSize, ...(cursor === undefined ? {} : { cursor }) };
}

function missingMeaningPageOptions(pageSize?: string, cursor?: string) {
  const parsedSize =
    pageSize === undefined ? 50 : /^(?:[1-9]\d*)$/.test(pageSize) ? Number(pageSize) : NaN;
  if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > 100) {
    throw new BadRequestException('每页缺释义词数量必须是 1 到 100 的整数');
  }
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512)) {
    throw new BadRequestException('缺释义词列表游标无效，请返回后重新加载');
  }
  return { pageSize: parsedSize, ...(cursor === undefined ? {} : { cursor }) };
}

class UpdateNewWordCountDto {
  @IsInt() @Min(5) @Max(40) defaultNewWordCount!: number;
}

class NotebookQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page: number = 1;
  @IsOptional() @IsString() @MaxLength(80) search: string = '';
  @IsOptional() @IsIn(['TRAVEL', 'READING', 'DAILY_SENTENCE', 'MANUAL', 'WORD']) source?: string;
}

class PersonalVocabularyItemDto {
  @IsOptional()
  @IsIn(['TRAVEL', 'READING', 'DAILY_SENTENCE', 'MANUAL', 'WORD'])
  sourceType?: string;
  @IsString() @MinLength(1) @MaxLength(120) text!: string;
  @IsEnum(LexicalItemType) type!: LexicalItemType;
  @IsString() @MinLength(1) @MaxLength(500) meaning!: string;
  @IsString() @MinLength(1) @MaxLength(800) example!: string;
  @IsOptional() @IsString() @MaxLength(160) sourceScenario?: string;
  @IsOptional() @IsEnum(CefrLevel) cefrLevel?: CefrLevel;
}

class PersonalVocabularyImportRowDto {
  @IsString() @MinLength(1) @MaxLength(120) text!: string;
  @IsString() @MinLength(1) @MaxLength(500) meaning!: string;
  @IsOptional() @IsString() @MaxLength(800) example?: string;
}

class PersonalVocabularyImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => PersonalVocabularyImportRowDto)
  items!: PersonalVocabularyImportRowDto[];
}

@ApiTags('vocabulary')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vocabulary')
export class VocabularyController {
  constructor(private readonly vocabulary: VocabularyService) {}

  @Get('system') system(
    @Req() request: AuthenticatedRequest,
    @Query('category') category?: string,
  ) {
    return this.vocabulary.listSystemBooks(request.user.sub, category);
  }
  @Get('system/:bookId/missing-meanings') missingMeanings(
    @Param('bookId') bookId: string,
    @Query('pageSize') pageSize?: string,
    @Query('cursor') cursor?: string,
  ) {
    const options = missingMeaningPageOptions(pageSize, cursor);
    return this.vocabulary.listMissingMeaningSystemBookWords(
      bookId,
      options.pageSize,
      options.cursor,
    );
  }
  @Get('learning') learning(@Req() request: AuthenticatedRequest) {
    return this.vocabulary.listLearningBooks(request.user.sub);
  }
  @Get('notebook') notebook(@Req() req: AuthenticatedRequest, @Query() dto: NotebookQuery) {
    return this.vocabulary.notebook(req.user.sub, dto.page, dto.search.trim(), dto.source);
  }
  @Delete('personal/items/:id') removePersonal(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.vocabulary.removePersonalItem(req.user.sub, id);
  }
  @Get('personal') personal(@Req() request: AuthenticatedRequest) {
    return this.vocabulary.listPersonalItems(request.user.sub);
  }
  @Post('personal/items') savePersonal(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PersonalVocabularyItemDto,
  ) {
    return this.vocabulary.savePersonalItem(request.user.sub, dto);
  }
  @Post('personal/items/import') importPersonal(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PersonalVocabularyImportDto,
  ) {
    return this.vocabulary.importPersonalItems(request.user.sub, dto.items);
  }
  @Delete('personal') clearPersonal(@Req() request: AuthenticatedRequest) {
    return this.vocabulary.clearPersonalItems(request.user.sub);
  }
  @Get('default') defaultBook(@Req() request: AuthenticatedRequest) {
    return this.vocabulary.getDefaultBook(request.user.sub);
  }
  @Get('progress-summary') progressSummary(@Req() request: AuthenticatedRequest) {
    return this.vocabulary.getProgressSummary(request.user.sub);
  }
  @Delete('learning-records') clearLearningRecords(@Req() request: AuthenticatedRequest) {
    return this.vocabulary.clearLearningRecords(request.user.sub);
  }
  @Get('mastered') mastered(
    @Req() request: AuthenticatedRequest,
    @Query('pageSize') pageSize?: string,
    @Query('cursor') cursor?: string,
  ) {
    const options = archivePageOptions(pageSize, cursor);
    return options
      ? this.vocabulary.listMasteredWordsPage(request.user.sub, options)
      : this.vocabulary.listMasteredWords(request.user.sub);
  }
  @Delete('mastered/:wordId') removeMastered(
    @Req() request: AuthenticatedRequest,
    @Param('wordId') wordId: string,
  ) {
    return this.vocabulary.removeMasteredWord(request.user.sub, wordId);
  }
  @Get('learning-words') learningWords(
    @Req() request: AuthenticatedRequest,
    @Query('pageSize') pageSize?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.vocabulary.listLearningWords(
      request.user.sub,
      archivePageOptions(pageSize, cursor),
    );
  }
  @Get('dashboard-words') dashboardWords(
    @Req() request: AuthenticatedRequest,
    @Query('newWordCount') newWordCount?: string,
    @Query('timeZone') timeZone?: string,
  ) {
    return this.vocabulary.getDashboardWords(request.user.sub, newWordCount, timeZone);
  }
  @Patch('dashboard-settings') updateDashboardSettings(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateNewWordCountDto,
  ) {
    return this.vocabulary.updateDefaultNewWordCount(request.user.sub, dto.defaultNewWordCount);
  }
  @Post('words/:bookWordId/review') addToReview(
    @Req() request: AuthenticatedRequest,
    @Param('bookWordId') bookWordId: string,
  ) {
    return this.vocabulary.addToReview(request.user.sub, bookWordId);
  }
  @Post('words/:bookWordId/master') markMastered(
    @Req() request: AuthenticatedRequest,
    @Param('bookWordId') bookWordId: string,
  ) {
    return this.vocabulary.markMastered(request.user.sub, bookWordId);
  }
  @Post('words/:bookWordId/defer') deferNewWord(
    @Req() request: AuthenticatedRequest,
    @Param('bookWordId') bookWordId: string,
  ) {
    return this.vocabulary.deferNewWord(request.user.sub, bookWordId);
  }
  @Post('words/:bookWordId/defer-review') deferReview(
    @Req() request: AuthenticatedRequest,
    @Param('bookWordId') bookWordId: string,
  ) {
    return this.vocabulary.deferReview(request.user.sub, bookWordId);
  }
  @Post('books/:bookId/start') start(
    @Req() request: AuthenticatedRequest,
    @Param('bookId') bookId: string,
  ) {
    return this.vocabulary.activateBook(request.user.sub, bookId);
  }
  @Post('books/:bookId/continue') continue(
    @Req() request: AuthenticatedRequest,
    @Param('bookId') bookId: string,
  ) {
    return this.vocabulary.activateBook(request.user.sub, bookId);
  }
}
