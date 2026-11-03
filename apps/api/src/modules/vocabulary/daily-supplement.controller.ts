import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
  Inject,
  ValidationPipe,
} from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DailySupplementService } from './daily-supplement.service';
class SetSupplementDto {
  @IsBoolean() enabled!: boolean;
}
@Controller('vocabulary/daily-supplement')
@UseGuards(JwtAuthGuard)
export class DailySupplementController {
  constructor(
    @Inject(DailySupplementService) private readonly supplement: DailySupplementService,
  ) {}
  @Get() preview(@Req() request: { user: { sub: string } }) {
    return this.supplement.preview(request.user.sub);
  }
  @Patch() setEnabled(
    @Req() request: { user: { sub: string } },
    @Body(new ValidationPipe({ expectedType: SetSupplementDto, whitelist: true, transform: true }))
    dto: SetSupplementDto,
  ) {
    return this.supplement.setEnabled(request.user.sub, dto.enabled);
  }
}
