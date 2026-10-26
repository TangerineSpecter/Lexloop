import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('statistics')
  statistics(@Req() request: { user: { sub: string } }, @Query('range') range?: string, @Query('timeZone') timeZone?: string) {
    const days = range === '365d' ? 365 : range === '30d' ? 30 : 7;
    return this.reports.statistics(request.user.sub, days, timeZone);
  }

  @Get('streak')
  streak(@Req() request: { user: { sub: string } }, @Query('timeZone') timeZone?: string) {
    return this.reports.streak(request.user.sub, timeZone);
  }

  @Get('career')
  career(@Req() request: { user: { sub: string } }) { return this.reports.career(request.user.sub); }

  @Get('history')
  history(@Req() request: { user: { sub: string } }, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.reports.history(request.user.sub, Number(page) || 1, Number(pageSize) || 20);
  }

  @Post('career/analysis')
  analysis(@Req() request: { user: { sub: string } }) { return this.reports.generateCareerAnalysis(request.user.sub); }
}
