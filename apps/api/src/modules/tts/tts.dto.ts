import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TtsRegion } from '@prisma/client';

export class TtsAudioTextDto {
  @IsString() @MinLength(1) @MaxLength(2_000) text!: string;
}

export class TtsGenerateDto extends TtsAudioTextDto {
  @IsBoolean() consent!: boolean;
}

export class SaveTtsConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsEnum(TtsRegion) region?: TtsRegion | null;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) model?: string;
  @IsOptional() @IsString() @MaxLength(200) voiceId?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.5) @Max(2) speed?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(10) volume?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-12) @Max(12) pitch?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1_000) apiKey?: string;
  @IsOptional() @IsBoolean() clearApiKey?: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxGenerationsPerUserPerDay?: number;
}
