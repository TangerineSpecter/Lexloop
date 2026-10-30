import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ChooseClassDto {
  @IsString() @MinLength(2) @MaxLength(40) classKey!: string;
}
export class StartRunDto {
  @IsString() floorId!: string;
  @Type(() => Number) @IsInt() @IsIn([5, 10, 15]) durationMinutes!: 5 | 10 | 15;
  @IsOptional() @IsIn(['BALANCED', 'RECALL', 'CONTEXT']) practiceFocus?:
    'BALANCED' | 'RECALL' | 'CONTEXT';
}
export class BattleActionDto {
  @IsString() @MinLength(8) @MaxLength(80) clientActionId!: string;
  @IsOptional() @IsString() @MaxLength(80) skillId?: string;
  @IsArray() answer!: unknown[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3_600_000) responseTimeMs?: number;
}
export class EquipItemDto {
  @IsOptional() @IsString() itemId?: string;
}
