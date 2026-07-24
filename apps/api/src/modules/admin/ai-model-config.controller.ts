import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AiModelProvider, Role } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AiModelConfigService } from './ai-model-config.service';

class AiModelDto {
  @IsString() @MinLength(1) displayName!: string;
  @IsEnum(AiModelProvider) provider!: AiModelProvider;
  @IsString() @MinLength(1) model!: string;
  @IsString() @MinLength(1) apiKey!: string;
  @IsOptional() @IsUrl({ require_tld: false }) baseUrl?: string;
}
class UpdateAiModelDto {
  @IsOptional() @IsString() @MinLength(1) displayName?: string;
  @IsOptional() @IsEnum(AiModelProvider) provider?: AiModelProvider;
  @IsOptional() @IsString() @MinLength(1) model?: string;
  @IsOptional() @IsString() @MinLength(1) apiKey?: string;
  @IsOptional() @IsUrl({ require_tld: false }) baseUrl?: string;
}
class EnabledDto { @IsBoolean() isEnabled!: boolean; }

@ApiTags('admin/ai-models')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/ai-models')
export class AiModelConfigController {
  constructor(private readonly models: AiModelConfigService) {}
  @Get() list() { return this.models.list(); }
  @Post() create(@Body() dto: AiModelDto) { return this.models.create(dto); }
  @Put(':id') update(@Param('id') id: string, @Body() dto: UpdateAiModelDto) { return this.models.update(id, dto); }
  @Patch(':id/enabled') setEnabled(@Param('id') id: string, @Body() dto: EnabledDto) { return this.models.setEnabled(id, dto.isEnabled); }
  @Delete(':id') remove(@Param('id') id: string) { return this.models.remove(id); }
}
