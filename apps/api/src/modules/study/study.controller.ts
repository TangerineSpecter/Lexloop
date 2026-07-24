import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StudyService } from './study.service';

type AuthenticatedRequest = { user: { sub: string } };
class AnswerDto {
  @IsString() bookWordId!: string;
  @IsArray() @IsString({ each: true }) selectedAnswer!: string[];
  @IsOptional() @IsInt() @Min(0) @Max(3_600_000) responseTimeMs?: number;
}
class CompleteGroupDto { @IsArray() @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[]; }
class CreatePlanDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) newWordCount?: number;
  @IsOptional() @IsIn(['group', 'individual', 'exam']) mode?: 'group' | 'individual' | 'exam';
}

@UseGuards(JwtAuthGuard)
@Controller('study')
export class StudyController {
  constructor(private readonly study: StudyService) {}
  @Get('plans') list(@Req() request: AuthenticatedRequest) { return this.study.listPlans(request.user.sub); }
  @Post('plans') create(@Req() request: AuthenticatedRequest, @Body() dto: CreatePlanDto) { return this.study.createPlan(request.user.sub, dto.newWordCount, dto.mode); }
  @Post('plans/:planId/generate') generate(@Req() request: AuthenticatedRequest, @Param('planId') planId: string) { return this.study.generatePlan(request.user.sub, planId); }
  @Post('plans/:planId/groups/:groupIndex/complete') complete(@Req() request: AuthenticatedRequest, @Param('planId') planId: string, @Param('groupIndex') groupIndex: string, @Body() dto: CompleteGroupDto) { return this.study.completeGroup(request.user.sub, planId, Number(groupIndex), dto.answers); }
}
