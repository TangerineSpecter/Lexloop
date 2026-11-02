import { Controller, Delete, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SystemLogService, type SystemLogFilters } from './system-log.service';

type CsvResponse = { header(name: string, value: string): unknown };

class SystemLogQueryDto implements SystemLogFilters {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsIn(['error', 'info', 'all']) severity?: 'error' | 'info' | 'all';
  @IsOptional() @IsIn(['api', 'worker']) source?: 'api' | 'worker';
  @IsOptional() @IsString() @MaxLength(80) search?: string;
}

class SystemLogExportQueryDto extends SystemLogQueryDto {
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) fingerprint?: string;
}

@ApiTags('admin/system-logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/system-logs')
export class SystemLogController {
  constructor(private readonly logs: SystemLogService) {}

  @Get()
  list(@Query() query: SystemLogQueryDto) {
    return this.logs.list(query);
  }

  @Get('export')
  async export(
    @Query() query: SystemLogExportQueryDto,
    @Res({ passthrough: true }) response: CsvResponse,
  ) {
    const result = await this.logs.exportCsv(query);
    response.header('Content-Type', 'text/csv; charset=utf-8');
    response.header('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.header('Cache-Control', 'no-store');
    return result.csv;
  }

  @Delete('clear')
  clear() {
    return this.logs.clear();
  }
}
