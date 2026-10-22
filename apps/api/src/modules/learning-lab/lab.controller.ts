import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { LabKind } from '@lexloop/types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LabService } from './lab.service';

type Actor = { user: { sub: string } };
class HistoryQuery {
  @IsIn(['READING', 'GRAMMAR']) kind!: LabKind;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page: number = 1;
}
class CreateLesson {
  @IsIn(['READING', 'GRAMMAR']) kind!: LabKind;
  @IsString() @MinLength(8) @MaxLength(80) clientRequestId!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  wordIds: string[] = [];
  @IsOptional() @IsIn(['A2', 'B1', 'B2']) level: 'A2' | 'B1' | 'B2' = 'B1';
}
class SubmitLesson {
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(6)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(3, { each: true })
  answers!: number[];
}
@UseGuards(JwtAuthGuard)
@Controller('learning-lab')
export class LabController {
  constructor(private readonly lab: LabService) {}
  @Get('grammar-evidence') evidence(@Req() req: Actor) {
    return this.lab.grammarEvidence(req.user.sub);
  }
  @Get('lessons') history(@Req() req: Actor, @Query() dto: HistoryQuery) {
    return this.lab.history(req.user.sub, dto.kind, dto.page);
  }
  @Post('lessons') create(@Req() req: Actor, @Body() dto: CreateLesson) {
    return this.lab.create(req.user.sub, dto.kind, dto.clientRequestId, dto.wordIds, dto.level);
  }
  @Get('lessons/:id') detail(@Req() req: Actor, @Param('id') id: string) {
    return this.lab.detail(req.user.sub, id);
  }
  @Post('lessons/:id/answers') submit(
    @Req() req: Actor,
    @Param('id') id: string,
    @Body() dto: SubmitLesson,
  ) {
    return this.lab.submit(req.user.sub, id, dto.answers);
  }
}
