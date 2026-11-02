import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, StudyPlanMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  StudyContentBankService,
  type StudyContentBankFilters,
} from './study-content-bank.service';

type AuthenticatedRequest = { user: { sub: string } };

class StudyContentBankQueryDto implements StudyContentBankFilters {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
  @IsOptional() @IsIn(['active', 'disabled', 'all']) status?: 'active' | 'disabled' | 'all';
  @IsOptional() @IsEnum(StudyPlanMode) mode?: StudyPlanMode;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @IsIn(['all', 'negative']) feedback?: 'all' | 'negative';
}

class StudyContentBankStatusDto {
  @IsBoolean() isActive!: boolean;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

@ApiTags('admin/study-content-bank')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/study-content-bank')
export class StudyContentBankController {
  constructor(@Inject(StudyContentBankService) private readonly bank: StudyContentBankService) {}

  @Get()
  list(@Query() query: StudyContentBankQueryDto) {
    return this.bank.list(query);
  }

  @Patch(':id/status')
  setStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StudyContentBankStatusDto,
  ) {
    return this.bank.setActive(id, dto.isActive, dto.reason, request.user.sub);
  }
}
