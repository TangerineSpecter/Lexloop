import { Body, Controller, Get, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

class UpdateDailyGoalDto {
  @IsIn(['activity', 'reviews']) kind!: 'activity' | 'reviews';
  @IsOptional() @IsInt() @IsIn([5, 10, 15]) target?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('statistics')
  statistics(
    @Req() request: { user: { sub: string } },
    @Query('range') range?: string,
    @Query('timeZone') timeZone?: string,
  ) {
    const days = range === '365d' ? 365 : range === '30d' ? 30 : 7;
    return this.reports.statistics(request.user.sub, days, timeZone);
  }

  @Get('streak')
  streak(@Req() request: { user: { sub: string } }, @Query('timeZone') timeZone?: string) {
    return this.reports.streak(request.user.sub, timeZone);
  }

  @Patch('daily-goal')
  updateDailyGoal(
    @Req() request: { user: { sub: string } },
    @Body() dto: UpdateDailyGoalDto,
    @Query('timeZone') timeZone?: string,
  ) {
    return this.reports.updateDailyGoal(request.user.sub, dto.kind, dto.target, timeZone);
  }

  @Get('career')
  career(@Req() request: { user: { sub: string } }, @Query('timeZone') timeZone?: string) {
    return this.reports.career(request.user.sub, timeZone);
  }

  @Get('history')
  history(
    @Req() request: { user: { sub: string } },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reports.history(
      request.user.sub,
      Number(page) || 1,
      Number(pageSize) || 20,
      cursor,
    );
  }

  @Post('career/analysis')
  analysis(@Req() request: { user: { sub: string } }) {
    return this.reports.generateCareerAnalysis(request.user.sub);
  }
}
