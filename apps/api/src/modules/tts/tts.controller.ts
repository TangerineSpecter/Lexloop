import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TtsAudioTextDto, TtsGenerateDto } from './tts.dto';
import { TtsService } from './tts.service';

type AuthRequest = { user: { sub: string } };
type AudioReply = {
  header(name: string, value: string): AudioReply;
  send(payload: Buffer): unknown;
};

@ApiTags('tts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tts')
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  @Get('status') status() {
    return this.tts.publicStatus();
  }

  @Post('audio/lookup') lookup(@Req() req: AuthRequest, @Body() dto: TtsAudioTextDto) {
    return this.tts.lookup(req.user.sub, dto.text);
  }

  @Post('audio/generate')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  generate(@Req() req: AuthRequest, @Body() dto: TtsGenerateDto) {
    return this.tts.generate(req.user.sub, dto.text, dto.consent);
  }

  @Get('audio/:id')
  async readAudio(@Req() req: AuthRequest, @Param('id') id: string, @Res() reply: AudioReply) {
    const result = await this.tts.readAudio(req.user.sub, id);
    return reply
      .header('Content-Type', result.mimeType)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(result.audio);
  }
}
