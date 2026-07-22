import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

type CookieRequest = { cookies: { refresh_token?: string } };
type CookieReply = { setCookie(name: string, value: string, options: Record<string, unknown>): unknown };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('register') async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) reply: CookieReply) { return this.setRefreshCookie(reply, await this.auth.register(dto.email, dto.password, dto.displayName)); }
  @Post('login') async login(@Body() dto: LoginDto, @Res({ passthrough: true }) reply: CookieReply) { return this.setRefreshCookie(reply, await this.auth.login(dto.email, dto.password)); }
  @Post('refresh') async refresh(@Req() request: CookieRequest, @Res({ passthrough: true }) reply: CookieReply) {
    const refreshToken = request.cookies.refresh_token;
    if (!refreshToken) return this.auth.refresh('');
    return this.setRefreshCookie(reply, await this.auth.refresh(refreshToken));
  }
  @Get('me') @ApiBearerAuth() @UseGuards(JwtAuthGuard) me(@Req() request: { user: { sub: string } }) { return this.auth.findSafeUser(request.user.sub); }

  private setRefreshCookie(reply: CookieReply, result: Awaited<ReturnType<AuthService['login']>>) {
    reply.setCookie('refresh_token', result.refreshToken, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/v1/auth', maxAge: 30 * 24 * 60 * 60 });
    const { refreshToken: _refreshToken, ...response } = result;
    return response;
  }
}
