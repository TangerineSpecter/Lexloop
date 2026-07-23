import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'learner@lexloop.dev' }) @IsEmail() email!: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() displayName?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'learner@lexloop.dev' }) @IsEmail() email!: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password!: string;
}

export class UpdatePasswordDto {
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password!: string;
}
