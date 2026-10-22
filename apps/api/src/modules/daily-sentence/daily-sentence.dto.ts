import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class HistoryQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @IsOptional() @IsIn(['true', 'false']) favorites?: string;
}

export class UpdateSentenceDto {
  @ValidateIf((_, value) => value !== undefined) @IsBoolean() favorite?: boolean;
  @ValidateIf((_, value) => value !== undefined) @IsIn(['EASY', 'RIGHT', 'HARD']) difficulty?: 'EASY' | 'RIGHT' | 'HARD';
}
