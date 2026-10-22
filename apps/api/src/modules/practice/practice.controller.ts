import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { OutputService } from './output.service';
import { ConfusionService } from './confusion.service';
import { WeeklyService } from './weekly.service';

type Actor = { user: { sub: string } };
class HistoryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}
class RequestDto {
  @IsString() @MinLength(8) @MaxLength(80) clientRequestId!: string;
  @IsInt() @Min(0) @Max(3_600_000) responseTimeMs!: number;
}
class OutputDto extends RequestDto {
  @IsString() @MinLength(12) @MaxLength(1800) answer!: string;
}
class ChoiceDto {
  @IsString() @MaxLength(80) questionId!: string;
  @IsString() @MaxLength(80) selected!: string;
}
class ContrastDto extends RequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ChoiceDto)
  answers!: ChoiceDto[];
}
@UseGuards(JwtAuthGuard)
@Controller('practice')
export class PracticeController {
  constructor(
    private readonly output: OutputService,
    private readonly confusion: ConfusionService,
    private readonly weekly: WeeklyService,
  ) {}
  @Get('output/today') today(@Req() req: Actor) {
    return this.output.daily(req.user.sub);
  }
  @Get('output/history') historyOutput(@Req() req: Actor, @Query() dto: HistoryDto) {
    return this.output.history(req.user.sub, dto.page ?? 1);
  }
  @Post('output/:id/submissions') submit(
    @Req() req: Actor,
    @Param('id') id: string,
    @Body() dto: OutputDto,
  ) {
    return this.output.submit(
      req.user.sub,
      id,
      dto.answer.trim(),
      dto.clientRequestId,
      dto.responseTimeMs,
    );
  }
  @Get('output/submissions/:id') submission(@Req() req: Actor, @Param('id') id: string) {
    return this.output.submission(req.user.sub, id);
  }
  @Get('confusion') groups(@Req() req: Actor) {
    return this.confusion.list(req.user.sub);
  }
  @Get('confusion/history') history(@Req() req: Actor) {
    return this.confusion.history(req.user.sub);
  }
  @Post('confusion/:id/attempts') contrast(
    @Req() req: Actor,
    @Param('id') id: string,
    @Body() dto: ContrastDto,
  ) {
    return this.confusion.submit(
      req.user.sub,
      id,
      dto.answers,
      dto.clientRequestId,
      dto.responseTimeMs,
    );
  }
  @Get('weekly') prescription(@Req() req: Actor) {
    return this.weekly.prescription(req.user.sub);
  }
}
