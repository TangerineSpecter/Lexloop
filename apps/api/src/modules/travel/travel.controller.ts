import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDefined, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ScenarioCategory } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TravelService } from './travel.service';

type AuthenticatedRequest = { user: { sub: string } };

class AssessmentResponseDto {
  @IsString() itemId!: string;
  @IsDefined() answer!: unknown;
}
class StartScenarioDto {
  @IsString() templateId!: string;
}
class ScenarioTurnDto {
  @IsString() @MinLength(1) @MaxLength(1200) message!: string;
  @IsString() @MinLength(8) @MaxLength(80) clientMessageId!: string;
}
class ScenarioQueryDto {
  @IsOptional() @IsEnum(ScenarioCategory) category?: ScenarioCategory;
}
class ScenarioReportHistoryQueryDto {
  @IsOptional() @IsString() @MaxLength(80) cursor?: string;
}

@ApiTags('travel')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class TravelController {
  constructor(private readonly travel: TravelService) {}

  @Post('proficiency/assessments') startAssessment(@Req() request: AuthenticatedRequest) {
    return this.travel.startAssessment(request.user.sub);
  }
  @Post('proficiency/assessments/:id/responses') answerAssessment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AssessmentResponseDto,
  ) {
    return this.travel.answerAssessment(request.user.sub, id, dto.itemId, dto.answer);
  }
  @Post('proficiency/assessments/:id/complete') completeAssessment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.travel.completeAssessment(request.user.sub, id);
  }
  @Get('proficiency/profile') profile(@Req() request: AuthenticatedRequest) {
    return this.travel.profile(request.user.sub);
  }

  @Get('scenarios') scenarios(
    @Req() request: AuthenticatedRequest,
    @Query() query: ScenarioQueryDto,
  ) {
    return this.travel.listScenarios(request.user.sub, query.category);
  }
  @Get('scenario-sessions/active') resumableScenario(@Req() request: AuthenticatedRequest) {
    return this.travel.resumableScenario(request.user.sub);
  }
  @Get('scenario-sessions/latest-report') latestScenarioReport(
    @Req() request: AuthenticatedRequest,
  ) {
    return this.travel.latestScenarioReport(request.user.sub);
  }
  @Get('scenario-sessions/reports') scenarioReportHistory(
    @Req() request: AuthenticatedRequest,
    @Query() query: ScenarioReportHistoryQueryDto,
  ) {
    return this.travel.scenarioReportHistory(request.user.sub, query.cursor);
  }
  @Get('scenario-sessions/:id/report') scenarioReport(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.travel.scenarioReport(request.user.sub, id);
  }
  @Post('scenario-sessions') startScenario(
    @Req() request: AuthenticatedRequest,
    @Body() dto: StartScenarioDto,
  ) {
    return this.travel.startScenario(request.user.sub, dto.templateId);
  }
  @Post('scenario-sessions/:id/turns') scenarioTurn(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ScenarioTurnDto,
  ) {
    return this.travel.takeTurn(request.user.sub, id, dto.message.trim(), dto.clientMessageId);
  }
  @Post('scenario-sessions/:id/complete') completeScenario(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.travel.completeScenario(request.user.sub, id);
  }
  @Get('practice/today') today(@Req() request: AuthenticatedRequest) {
    return this.travel.todayPlan(request.user.sub);
  }
  @Delete('travel/records') clearRecords(@Req() request: AuthenticatedRequest) {
    return this.travel.clearRecords(request.user.sub);
  }
}
