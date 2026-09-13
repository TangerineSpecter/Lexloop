import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class ApplySystemUpdateDto {
  @ApiProperty({ example: '1.0.1' })
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  targetVersion!: string;

  @ApiProperty({ example: '0123456789abcdef0123456789abcdef01234567' })
  @IsString()
  @Matches(/^[0-9a-f]{40}$/)
  targetSha!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;
}
