import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { ASSESSMENT_ITEMS, LANGUAGE_SKILLS, SCENARIOS } from './travel.catalog';

@Injectable()
export class TravelSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TravelSeedService.name);
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    await this.seedAssessments();
    await this.seedScenarios();
    await this.seedSkills();
    this.logger.log(`旅行英语内容初始化完成：${SCENARIOS.length} 个场景，${ASSESSMENT_ITEMS.length} 道测评题。`);
  }

  private async seedAssessments() {
    for (const item of ASSESSMENT_ITEMS) {
      await this.prisma.assessmentItem.upsert({
        where: { id: item.id },
        create: { ...item, options: inputJson(item.options), correctAnswers: inputJson(item.correctAnswers), rubric: inputJson(item.rubric) },
        update: { ...item, options: inputJson(item.options), correctAnswers: inputJson(item.correctAnswers), rubric: inputJson(item.rubric), version: 1, isActive: true },
      });
    }
  }

  private async seedScenarios() {
    for (const scenario of SCENARIOS) {
      await this.prisma.scenarioTemplate.upsert({
        where: { id: scenario.id },
        create: scenario,
        update: { ...scenario, version: 1, isActive: true },
      });
    }
  }

  private async seedSkills() {
    for (const skill of LANGUAGE_SKILLS) {
      await this.prisma.languageSkill.upsert({ where: { id: skill.id }, create: skill, update: skill });
    }
  }
}

function inputJson(value: unknown) { return value === undefined ? undefined : value as Prisma.InputJsonValue; }
