import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { Readable } from 'node:stream';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiService, ChatCompletionRequest, OpenAiChatCompletionRequest } from './ai.service';
import { AiModelConfigService } from '../admin/ai-model-config.service';

class ExplainDto { @IsString() @MinLength(1) text!: string; }

/** OpenAI-compatible request fields are forwarded untouched to the configured Provider. */
class ChatCompletionDto implements ChatCompletionRequest {
  @IsOptional() @IsString() model?: string;
  @IsArray() @ArrayMinSize(1) messages!: Array<Record<string, unknown>>;
  @IsOptional() @IsBoolean() stream?: boolean;
  @IsOptional() temperature?: unknown;
  @IsOptional() audio?: unknown;
  @IsOptional() top_p?: unknown;
  @IsOptional() n?: unknown;
  @IsOptional() stop?: unknown;
  @IsOptional() seed?: unknown;
  @IsOptional() store?: unknown;
  @IsOptional() metadata?: unknown;
  @IsOptional() modalities?: unknown;
  @IsOptional() prediction?: unknown;
  @IsOptional() service_tier?: unknown;
  @IsOptional() safety_identifier?: unknown;
  @IsOptional() prompt_cache_key?: unknown;
  @IsOptional() verbosity?: unknown;
  @IsOptional() web_search_options?: unknown;
  @IsOptional() max_tokens?: unknown;
  @IsOptional() max_completion_tokens?: unknown;
  @IsOptional() stream_options?: unknown;
  @IsOptional() response_format?: unknown;
  @IsOptional() tools?: unknown;
  @IsOptional() tool_choice?: unknown;
  @IsOptional() parallel_tool_calls?: unknown;
  @IsOptional() functions?: unknown;
  @IsOptional() function_call?: unknown;
  @IsOptional() logit_bias?: unknown;
  @IsOptional() logprobs?: unknown;
  @IsOptional() top_logprobs?: unknown;
  @IsOptional() user?: unknown;
  @IsOptional() user_id?: unknown;
  @IsOptional() thinking?: unknown;
  @IsOptional() reasoning_effort?: unknown;
  @IsOptional() frequency_penalty?: unknown;
  @IsOptional() presence_penalty?: unknown;
}

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService, private readonly models: AiModelConfigService) {}

  @Get('models') modelsList(@Req() request: { user: { sub: string } }) { return this.models.listEnabled(request.user.sub); }
  @Patch('models/:id/select') selectModel(@Param('id') id: string, @Req() request: { user: { sub: string } }) { return this.models.selectForUser(request.user.sub, id); }

  @Post('explain') explain(@Body() dto: ExplainDto) { return this.ai.explain(dto.text); }

  @Post('chat/completions')
  @ApiBody({ description: 'OpenAI Chat Completions-compatible request. The server always uses the authenticated user\'s selected enabled system model.' })
  async chatCompletions(@Body() dto: ChatCompletionDto, @Req() request: { user: { sub: string } }, @Res() reply: any) {
    const response = await this.ai.chatCompletions(dto as OpenAiChatCompletionRequest, request.user.sub);
    const contentType = response.headers.get('content-type') || (dto.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
    reply.header('content-type', contentType);
    if (dto.stream) {
      const body = response.body;
      if (!body) return reply.send();
      return reply.send(Readable.fromWeb(body as any));
    }
    return reply.send(await response.json());
  }
}
