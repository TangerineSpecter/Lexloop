import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SaveTtsConfigDto } from './tts.dto';
import { TtsConfigService } from './tts-config.service';
import { TtsService } from './tts.service';

type AuthRequest = { user: { sub: string } };

@ApiTags('admin/tts-config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/tts-config')
export class TtsAdminController {
  constructor(
    private readonly config: TtsConfigService,
    private readonly tts: TtsService,
  ) {}

  @Get() get() {
    return this.config.publicConfig();
  }

  @Put() save(@Body() dto: SaveTtsConfigDto) {
    return this.config.save(dto);
  }

  @Post('test')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async test(@Req() req: AuthRequest) {
    const audio = await this.tts.testConnection(req.user.sub);
    return { success: true, mimeType: 'audio/mpeg', audioBase64: audio.toString('base64') };
  }
}
