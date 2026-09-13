import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ApplySystemUpdateDto } from './system-update.dto';
import { SystemUpdateService } from './system-update.service';

@ApiTags('admin/system/update')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/system/update')
export class SystemUpdateController {
  constructor(private readonly updates: SystemUpdateService) {}

  @Get()
  status() {
    return this.updates.status();
  }

  @Post('check')
  check() {
    return this.updates.check();
  }

  @Post('apply')
  @HttpCode(HttpStatus.ACCEPTED)
  apply(
    @Req() request: { user: { sub: string; email: string } },
    @Body() dto: ApplySystemUpdateDto,
  ) {
    return this.updates.apply(request.user, dto);
  }

  @Get('jobs/:id')
  job(@Param('id') id: string) {
    return this.updates.job(id);
  }
}
