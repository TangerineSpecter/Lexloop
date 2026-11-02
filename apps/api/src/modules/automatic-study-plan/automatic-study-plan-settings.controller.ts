import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsBoolean, IsString, Matches } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AutomaticStudyPlanSettingsService } from './automatic-study-plan-settings.service';

class AutomaticStudyPlanSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) scheduleTime!: string;
}

@ApiTags('admin/automatic-study-plan')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/automatic-study-plan/settings')
export class AutomaticStudyPlanSettingsController {
  constructor(private readonly settings: AutomaticStudyPlanSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  set(@Body() dto: AutomaticStudyPlanSettingsDto) {
    return this.settings.set(dto);
  }
}
