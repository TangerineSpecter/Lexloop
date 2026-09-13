import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdventureService } from './adventure.service';
import { BattleActionDto, ChooseClassDto, EquipItemDto, StartRunDto } from './adventure.dto';

type AuthenticatedRequest = { user: { sub: string } };

@ApiTags('adventure')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('adventure')
export class AdventureController {
  constructor(private readonly adventure: AdventureService) {}

  @Get('profile') profile(@Req() request: AuthenticatedRequest) { return this.adventure.profile(request.user.sub); }
  @Post('profile/class') chooseClass(@Req() request: AuthenticatedRequest, @Body() dto: ChooseClassDto) { return this.adventure.chooseClass(request.user.sub, dto.classKey); }
  @Post('class-advancements') advanceClass(@Req() request: AuthenticatedRequest, @Body() dto: ChooseClassDto) { return this.adventure.advanceClass(request.user.sub, dto.classKey); }
  @Post('skills/:skillId/unlock') unlockSkill(@Req() request: AuthenticatedRequest, @Param('skillId') skillId: string) { return this.adventure.unlockSkill(request.user.sub, skillId); }
  @Get('dungeons') dungeons(@Req() request: AuthenticatedRequest) { return this.adventure.dungeons(request.user.sub); }
  @Post('runs') startRun(@Req() request: AuthenticatedRequest, @Body() dto: StartRunDto) { return this.adventure.startRun(request.user.sub, dto.floorId, dto.durationMinutes); }
  @Get('runs/active') activeRun(@Req() request: AuthenticatedRequest) { return this.adventure.activeRun(request.user.sub); }
  @Post('runs/:runId/actions') act(@Req() request: AuthenticatedRequest, @Param('runId') runId: string, @Body() dto: BattleActionDto) { return this.adventure.act(request.user.sub, runId, dto); }
  @Post('runs/:runId/retreat') retreat(@Req() request: AuthenticatedRequest, @Param('runId') runId: string) { return this.adventure.retreat(request.user.sub, runId); }
  @Get('inventory') inventory(@Req() request: AuthenticatedRequest) { return this.adventure.inventory(request.user.sub); }
  @Post('equipment/:itemId/equip') equip(@Req() request: AuthenticatedRequest, @Param('itemId') itemId: string, @Body() _dto: EquipItemDto) { return this.adventure.equip(request.user.sub, itemId); }
  @Get('daily-quests') dailyQuests(@Req() request: AuthenticatedRequest) { return this.adventure.dailyQuests(request.user.sub); }
  @Post('daily-quests/:questId/claim') claimQuest(@Req() request: AuthenticatedRequest, @Param('questId') questId: string) { return this.adventure.claimQuest(request.user.sub, questId); }
}
