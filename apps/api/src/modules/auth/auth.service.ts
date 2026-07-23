import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type SafeUser = Pick<User, 'id' | 'email' | 'displayName' | 'role'>;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly config: ConfigService) {}

  async register(email: string, password: string, displayName?: string) {
    const normalizedEmail = email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email: normalizedEmail } })) throw new ConflictException('邮箱已被注册');
    const user = await this.prisma.user.create({ data: { email: normalizedEmail, passwordHash: await argon2.hash(password), displayName } });
    return this.issueTokens(user);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException('邮箱或密码错误');
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; jti: string };
    try { payload = await this.jwt.verifyAsync(refreshToken, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET') }); }
    catch { throw new UnauthorizedException('登录已过期'); }
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenId: payload.jti } });
    if (!record || record.userId !== payload.sub || record.expiresAt <= new Date() || !(await argon2.verify(record.tokenHash, refreshToken))) throw new UnauthorizedException('登录已过期');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    await this.prisma.refreshToken.delete({ where: { id: record.id } });
    return this.issueTokens(user);
  }

  async findSafeUser(id: string): Promise<SafeUser> { return this.prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, displayName: true, role: true } }); }

  async updatePassword(id: string, password: string) {
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await argon2.hash(password) } });
    await this.prisma.refreshToken.deleteMany({ where: { userId: id } });
    return { message: '密码已更新，请重新登录。' };
  }

  private async issueTokens(user: Pick<User, 'id' | 'email' | 'role' | 'displayName'>) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const tokenId = randomUUID();
    const accessToken = await this.jwt.signAsync(payload, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '15m' });
    const refreshToken = await this.jwt.signAsync({ ...payload, jti: tokenId }, { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: '30d' });
    await this.prisma.refreshToken.create({ data: { userId: user.id, tokenId, tokenHash: await argon2.hash(refreshToken), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    return { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role as Role }, accessToken, refreshToken };
  }
}
