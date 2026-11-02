import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AiService } from './ai.service';
import { SystemLogService } from '../admin/system-log.service';

@ApiTags('admin/ai-models')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/ai-models')
export class AiModelTestController {
  constructor(
    private readonly ai: AiService,
    private readonly logs: SystemLogService,
  ) {}

  @Post(':id/test')
  async test(@Param('id') id: string) {
    const result = await this.ai.testConfiguredModel(id);
    if (!result.success) {
      void this.logs.record({
        source: 'api',
        kind: 'ai.model_test',
        code: `MODEL_TEST_${result.code ?? result.upstreamStatus ?? 'NO_RESPONSE'}`,
        ...(result.upstreamStatus ? { upstreamStatus: result.upstreamStatus } : {}),
        ...(result.param ? { param: result.param } : {}),
        method: 'POST',
        route: '/api/v1/admin/ai-models/:id/test',
        reason: result.reason,
      });
    }
    return result;
  }
}
