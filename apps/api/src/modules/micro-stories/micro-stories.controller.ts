import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MicroStoriesService } from './micro-stories.service';

type Actor = { user: { sub: string } };
class InterpretDto {
  @IsString() @MinLength(1) @MaxLength(500) interpretation!: string;
}
class CompleteDto {
  @IsBoolean() mismatch!: boolean;
  @IsString() @MaxLength(280) ownSentence!: string;
}
class ReviewDto {
  @IsBoolean() remembered!: boolean;
}
class SelectStoryDto {
  @IsString() @MinLength(1) @MaxLength(80) key!: string;
  @IsString() @MinLength(1) @MaxLength(80) expectedKey!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('micro-stories')
export class MicroStoriesController {
  constructor(private readonly stories: MicroStoriesService) {}
  @Get('current') current(@Req() req: Actor) {
    return this.stories.current(req.user.sub);
  }
  @Get('errors') errors(@Req() req: Actor) {
    return this.stories.errors(req.user.sub);
  }
  @Get('completed')
  @Header('Cache-Control', 'private, no-store')
  completed(@Req() req: Actor) {
    return this.stories.completed(req.user.sub);
  }
  @Get('completed/:key')
  @Header('Cache-Control', 'private, no-store')
  revisit(@Req() req: Actor, @Param('key') key: string) {
    return this.stories.revisit(req.user.sub, key);
  }
  @Post('selection') select(@Req() req: Actor, @Body() dto: SelectStoryDto) {
    return this.stories.select(req.user.sub, dto.key, dto.expectedKey);
  }
  @Post(':key/interpret') interpret(
    @Req() req: Actor,
    @Param('key') key: string,
    @Body() dto: InterpretDto,
  ) {
    return this.stories.interpret(req.user.sub, key, dto.interpretation.trim());
  }
  @Post(':key/complete') complete(
    @Req() req: Actor,
    @Param('key') key: string,
    @Body() dto: CompleteDto,
  ) {
    return this.stories.complete(req.user.sub, key, dto.mismatch, dto.ownSentence);
  }
  @Post('reviews/:id') review(@Req() req: Actor, @Param('id') id: string, @Body() dto: ReviewDto) {
    return this.stories.review(req.user.sub, id, dto.remembered);
  }
}
