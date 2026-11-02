import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ApplySystemUpdateDto, SystemAutoUpdateSettingsDto } from './system-update.dto';
import { SystemUpdateService } from './system-update.service';
import { SystemLogService } from './system-log.service';

const CHECK_LOG_CODES = new Set([
  'GIT_TLS_INTERRUPTED',
  'GIT_FETCH_TIMEOUT',
  'GIT_NETWORK_INTERRUPTED',
  'GIT_AUTH_FAILED',
  'GIT_REPOSITORY_UNAVAILABLE',
  'GIT_FETCH_FAILED',
  'GIT_CHECK_TIMEOUT',
  'UPDATER_CHECK_INTERRUPTED',
  'UPDATER_REFRESH_FAILED',
]);

@ApiTags('admin/system/update')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/system/update')
export class SystemUpdateController {
  private readonly loggedCheckAttempts = new Set<string>();

  constructor(
    private readonly updates: SystemUpdateService,
    private readonly logs: SystemLogService,
  ) {}

  @Get()
  async status() {
    const status = await this.updates.status();
    this.logCheckFailure(status, 'GET');
    return status;
  }

  @Post('check')
  async check() {
    const status = await this.updates.check();
    this.logCheckFailure(status, 'POST');
    return status;
  }

  @Get('auto')
  autoUpdateStatus() {
    return this.updates.autoUpdateStatus();
  }

  @Post('auto')
  saveAutoUpdate(@Body() dto: SystemAutoUpdateSettingsDto) {
    return this.updates.saveAutoUpdate(dto);
  }

  private logCheckFailure(
    status: Awaited<ReturnType<SystemUpdateService['status']>>,
    method: 'GET' | 'POST',
  ) {
    const attemptId = status.checkAttemptId;
    const code = status.checkErrorCode;
    if (
      !status.updaterAvailable ||
      !status.error ||
      !attemptId ||
      !CHECK_LOG_CODES.has(code ?? '') ||
      this.loggedCheckAttempts.has(attemptId)
    ) {
      return;
    }
    this.loggedCheckAttempts.add(attemptId);
    if (this.loggedCheckAttempts.size > 256) {
      const oldest = this.loggedCheckAttempts.values().next().value;
      if (oldest) this.loggedCheckAttempts.delete(oldest);
    }
    void this.logs
      .record({
        source: 'api',
        kind: 'system.update_check',
        code: `UPDATE_CHECK_${code}`,
        method,
        route: '/api/v1/admin/system/update',
        phase: 'final',
        attemptsMade: Math.max(0, Math.min(status.checkAttempts ?? 0, 3)),
        maxAttempts: 3,
        reason: '更新仓库检查失败；原始 Git 输出已隐藏。',
        ...(status.checkFinishedAt && !Number.isNaN(Date.parse(status.checkFinishedAt))
          ? { at: new Date(status.checkFinishedAt) }
          : {}),
      })
      .catch(() => undefined);
  }

  @Post('apply')
  @HttpCode(HttpStatus.ACCEPTED)
  apply(
    @Req() request: { user: { sub: string; email: string } },
    @Body() dto: ApplySystemUpdateDto,
  ) {
    return this.updates.apply(request.user, dto);
  }

  @Get('jobs/:id')
  job(@Param('id') id: string) {
    return this.updates.job(id);
  }
}
