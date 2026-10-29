import { Body, Controller, Delete, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Readable } from 'node:stream';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TutorContext, TutorService } from './tutor.service';

class TutorContextDto {
  @IsIn(['STUDY_GROUP', 'MISTAKE']) type!: 'STUDY_GROUP' | 'MISTAKE';
  @ValidateIf((value) => value.type === 'STUDY_GROUP') @IsString() planId?: string;
  @ValidateIf((value) => value.type === 'STUDY_GROUP')
  @Type(() => Number)
  @IsInt()
  @Min(0)
  groupIndex?: number;
  @ValidateIf((value) => value.type === 'MISTAKE') @IsString() weaknessId?: string;
}
class TutorHistoryQueryDto extends TutorContextDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}
class TutorMessageDto extends TutorContextDto {
  @IsString() @MinLength(1) @MaxLength(1000) message!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('ai/tutor')
export class TutorController {
  constructor(private readonly tutor: TutorService) {}
  @Get('history') history(
    @Req() request: { user: { sub: string } },
    @Query() query: TutorHistoryQueryDto,
  ) {
    return this.tutor.history(request.user.sub, contextOf(query), query.page, query.pageSize);
  }
  @Delete('history') clear(
    @Req() request: { user: { sub: string } },
    @Query() query: TutorContextDto,
  ) {
    return this.tutor.clear(request.user.sub, contextOf(query));
  }
  @Post('messages') async message(
    @Req() request: { user: { sub: string } },
    @Body() dto: TutorMessageDto,
    @Res() reply: any,
  ) {
    const abortController = new AbortController();
    const response = reply.raw;
    let responseStream: Readable | null = null;
    const cleanup = () => {
      response.off('close', onClose);
      response.off('finish', cleanup);
    };
    const onClose = () => {
      if (response.writableEnded) {
        cleanup();
        return;
      }
      abortController.abort();
      responseStream?.destroy();
      cleanup();
    };
    response.once('close', onClose);
    response.once('finish', cleanup);

    try {
      const prepared = await this.tutor.prepareMessage(
        request.user.sub,
        contextOf(dto),
        dto.message.trim(),
        abortController.signal,
      );
      if (abortController.signal.aborted) {
        // The client can disconnect while the message is being persisted. Start
        // the generator so it can fail the pending row and refund its reservation.
        for await (const _chunk of prepared.stream) {
          /* No client remains to receive the chunks. */
        }
        cleanup();
        return undefined;
      }
      reply.header('content-type', 'text/event-stream; charset=utf-8');
      reply.header('cache-control', 'no-cache, no-transform');
      reply.header('x-accel-buffering', 'no');
      responseStream = Readable.from(prepared.stream);
      return reply.send(responseStream);
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}

function contextOf(input: TutorContextDto): TutorContext {
  return input.type === 'STUDY_GROUP'
    ? { type: 'STUDY_GROUP', planId: input.planId!, groupIndex: input.groupIndex! }
    : { type: 'MISTAKE', weaknessId: input.weaknessId! };
}
