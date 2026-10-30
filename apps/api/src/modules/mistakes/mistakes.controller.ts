import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MistakesService } from './mistakes.service';

type AuthenticatedRequest = { user: { sub: string } };
class MistakeQueryDto {
  @IsOptional() @IsIn(['active', 'ignored', 'resolved']) status?: 'active' | 'ignored' | 'resolved';
  @IsOptional() @IsString() questionType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}
class MistakeDetailQueryDto {
  @IsOptional() @IsString() @MaxLength(512) attemptCursor?: string;
  @IsOptional() @IsIn(['older', 'newer']) attemptDirection?: 'older' | 'newer';
}
class StatusDto {
  @IsIn(['ACTIVE', 'IGNORED']) status!: 'ACTIVE' | 'IGNORED';
}
class PracticePlanDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) bookWordIds!: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('mistakes')
export class MistakesController {
  constructor(private readonly mistakes: MistakesService) {}
  @Get() list(@Req() request: AuthenticatedRequest, @Query() query: MistakeQueryDto) {
    return this.mistakes.list(request.user.sub, query);
  }
  @Get(':id')
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: MistakeDetailQueryDto,
  ) {
    return this.mistakes.detail(request.user.sub, id, query.attemptCursor, query.attemptDirection);
  }
  @Patch(':id/status') setStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StatusDto,
  ) {
    return this.mistakes.setStatus(request.user.sub, id, dto.status);
  }
  @Post('practice-plans') createPracticePlan(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PracticePlanDto,
  ) {
    return this.mistakes.createPracticePlan(request.user.sub, dto.bookWordIds);
  }
}
