import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BackupActionDto, BackupSettingsDto } from './system-backup.dto';
import { SystemUpdateService } from './system-update.service';

@ApiTags('admin/system/backups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/system/backups')
export class SystemBackupController {
  constructor(private readonly operations: SystemUpdateService) {}

  @Get() status() {
    return this.operations.backupStatus();
  }

  @Post('config')
  save(@Req() request: { user: { sub: string } }, @Body() dto: BackupSettingsDto) {
    return this.operations.saveBackup(request.user.sub, dto);
  }

  @Post('run')
  @HttpCode(202)
  run(@Req() request: { user: { sub: string } }, @Body() dto: BackupActionDto) {
    return this.operations.runBackup(request.user.sub, dto.password);
  }
}
