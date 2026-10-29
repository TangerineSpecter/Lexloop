import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { DailySentenceSettingsService } from './daily-sentence-settings.service';

class DailySentenceSettingsDto {
  @IsBoolean() enabled!: boolean;
}

@ApiTags('admin/daily-sentence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/daily-sentence/settings')
export class DailySentenceSettingsController {
  constructor(private readonly settings: DailySentenceSettingsService) {}
  @Get() get() {
    return this.settings.get();
  }
  @Patch() set(@Body() dto: DailySentenceSettingsDto) {
    return this.settings.set(dto.enabled);
  }
}
