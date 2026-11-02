import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, Matches, Max, Min, MinLength } from 'class-validator';

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

export class SystemAutoUpdateSettingsDto {
  @ApiProperty({ description: '管理员主动授权自动安装可信版本' })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ minimum: 6, maximum: 168, description: '检查间隔（小时）' })
  @IsInt()
  @Min(6)
  @Max(168)
  intervalHours!: number;
}
