import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DailySentenceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const setting = await this.prisma.systemFeatureSetting.findUnique({
      where: { key: 'daily-sentence' },
    });
    return { enabled: setting?.enabled ?? true };
  }

  async set(enabled: boolean) {
    const setting = await this.prisma.systemFeatureSetting.upsert({
      where: { key: 'daily-sentence' },
      create: { key: 'daily-sentence', enabled },
      update: { enabled },
    });
    return { enabled: setting.enabled };
  }
}
