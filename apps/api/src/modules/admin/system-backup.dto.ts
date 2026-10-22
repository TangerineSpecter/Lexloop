import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class BackupActionDto {
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  password!: string;
}

export class BackupSettingsDto extends BackupActionDto {
  @IsOptional() @IsBoolean() resetConfig?: boolean;
  @IsBoolean() enabled!: boolean;
  @IsString() @Matches(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/) host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsString() @Matches(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/) username!: string;
  @IsString()
  @MaxLength(500)
  @Matches(/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/?)*$/)
  remotePath!: string;
  @IsString()
  @MaxLength(4096)
  @Matches(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/)
  hostKey!: string;
  @IsOptional() @IsString() @MaxLength(16384) privateKey?: string;
  @IsOptional() @IsString() @MaxLength(1024) passphrase?: string;
}
