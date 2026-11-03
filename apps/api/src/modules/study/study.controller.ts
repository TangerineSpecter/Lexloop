import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { StudyContentFeedbackRating, StudyContentFeedbackReason } from '@prisma/client';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StudyService } from './study.service';

type AuthenticatedRequest = { user: { sub: string } };
class AnswerDto {
  @IsString() bookWordId!: string;
  @IsArray() @IsString({ each: true }) selectedAnswer!: string[];
  @IsOptional() @IsInt() @Min(0) @Max(3_600_000) responseTimeMs?: number;
}
class CompleteGroupDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[];
}
class PublicQuestionFeedbackDto {
  @IsIn([StudyContentFeedbackRating.UP, StudyContentFeedbackRating.DOWN])
  rating!: StudyContentFeedbackRating;
  @IsOptional()
  @IsIn(Object.values(StudyContentFeedbackReason))
  reason?: StudyContentFeedbackReason;
}
class CreatePlanDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) newWordCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(40) reviewWordCount?: number;
  @IsOptional() @IsIn(['group', 'individual', 'exam']) mode?: 'group' | 'individual' | 'exam';
  @IsOptional() @IsIn(['book', 'mistakes', 'random', 'frequent', 'due']) selection?:
    'book' | 'mistakes' | 'random' | 'frequent' | 'due';
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  skipReviewWordIds?: string[];
}
class CreateProgressivePlanDto {
  @IsOptional()
  @IsIn(['foundation', 'context', 'transfer'])
  stage?: 'foundation' | 'context' | 'transfer';
}
class CompletedHistoryQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}
class RecoverablePlansQueryDto {
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('study')
export class StudyController {
  constructor(@Inject(StudyService) private readonly study: StudyService) {}
  @Get('progressive-path') progressivePath(@Req() request: AuthenticatedRequest) {
    return this.study.getProgressivePath(request.user.sub);
  }
  @Post('progressive-path/plans') createProgressivePlan(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProgressivePlanDto,
  ) {
    return this.study.createProgressivePlan(request.user.sub, dto.stage);
  }
  @Get('plans') list(@Req() request: AuthenticatedRequest) {
    return this.study.listPlans(request.user.sub);
  }
  @Get('plans/recovery') recovery(
    @Req() request: AuthenticatedRequest,
    @Query() query: RecoverablePlansQueryDto,
  ) {
    return this.study.listRecoverablePlans(request.user.sub, query.cursor, query.pageSize);
  }
  @Get('plans/history') history(
    @Req() request: AuthenticatedRequest,
    @Query() query: CompletedHistoryQueryDto,
  ) {
    return this.study.listCompletedPlans(request.user.sub, query.page, query.pageSize);
  }
  @Get('plans/:planId/generation-status') generationStatus(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
  ) {
    return this.study.getGenerationStatus(request.user.sub, planId);
  }
  @Get('plans/:planId') getPlan(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
  ) {
    return this.study.getPlan(request.user.sub, planId);
  }
  @Get('plans/:planId/review') review(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
  ) {
    return this.study.getCompletedPlanReview(request.user.sub, planId);
  }
  @Post('plans') create(@Req() request: AuthenticatedRequest, @Body() dto: CreatePlanDto) {
    return this.study.createPlan(
      request.user.sub,
      dto.newWordCount,
      dto.mode,
      dto.reviewWordCount,
      dto.selection,
      dto.skipReviewWordIds,
    );
  }
  @Post('plans/:planId/generate') generate(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
  ) {
    return this.study.generatePlan(request.user.sub, planId);
  }
  @Post('plans/:planId/groups/:groupIndex/complete') complete(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Param('groupIndex') groupIndex: string,
    @Body() dto: CompleteGroupDto,
  ) {
    return this.study.completeGroup(request.user.sub, planId, Number(groupIndex), dto.answers);
  }
  @Post('plans/:planId/public-questions/:bookWordId/feedback') feedback(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Param('bookWordId') bookWordId: string,
    @Body() dto: PublicQuestionFeedbackDto,
  ) {
    return this.study.ratePublicQuestion(
      request.user.sub,
      planId,
      bookWordId,
      dto.rating,
      dto.reason,
    );
  }
  @Delete('plans/:planId/public-questions/:bookWordId/feedback') withdrawFeedback(
    @Req() request: AuthenticatedRequest,
    @Param('planId') planId: string,
    @Param('bookWordId') bookWordId: string,
  ) {
    return this.study.withdrawPublicQuestionFeedback(request.user.sub, planId, bookWordId);
  }
}
