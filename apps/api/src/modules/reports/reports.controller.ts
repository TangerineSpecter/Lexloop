import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('statistics')
  statistics(@Req() request: { user: { sub: string } }, @Query('range') range?: string) {
    return this.reports.statistics(request.user.sub, range === '30d' ? 30 : 7);
  }
}
