import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthModule } from '../auth/auth.module';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AiModelConfigController } from './ai-model-config.controller';
import { AiModelConfigService } from './ai-model-config.service';
import { SystemBackupController } from './system-backup.controller';
import { SystemUpdateController } from './system-update.controller';
import { SystemUpdateService } from './system-update.service';
import { SystemLogController } from './system-log.controller';
import { SystemLogExceptionFilter } from './system-log-exception.filter';
import { SystemLogService } from './system-log.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
class AdminController {
  @Get('health') health() {
    return { status: 'ok', role: 'admin' };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [
    SystemBackupController,
    AdminController,
    AiModelConfigController,
    SystemUpdateController,
    SystemLogController,
  ],
  providers: [
    AiModelConfigService,
    SystemUpdateService,
    SystemLogService,
    SystemLogExceptionFilter,
  ],
  exports: [AiModelConfigService, SystemLogService, SystemLogExceptionFilter],
})
export class AdminModule {}
