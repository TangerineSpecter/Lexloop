import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/modules/auth/auth.service';

const user = { id: 'user_1', email: 'learner@lexloop.dev', displayName: 'Learner', role: 'USER' as const, passwordHash: '' };

describe('AuthService', () => {
  const prisma = { user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn() }, refreshToken: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() } };
  const jwt = { signAsync: vi.fn(), verifyAsync: vi.fn() };
  const config = { getOrThrow: vi.fn((key: string) => `${key}-value`) };
  let service: AuthService;

  beforeEach(async () => {
    vi.resetAllMocks();
    user.passwordHash = await argon2.hash('correct-password');
    service = new AuthService(prisma as never, jwt as never, config as never);
  });

  it('issues an access token and persists a hashed, jti-addressable refresh token', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    jwt.signAsync.mockResolvedValueOnce('access-token').mockResolvedValueOnce('refresh-token');

    const result = await service.login(user.email, 'correct-password');

    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: user.id, tokenId: expect.any(String), tokenHash: expect.any(String) }) }));
    expect(jwt.signAsync).toHaveBeenLastCalledWith(expect.objectContaining({ sub: user.id, jti: expect.any(String) }), expect.objectContaining({ expiresIn: '30d' }));
  });

  it('rejects a refresh token whose jti cannot be found', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: user.id, jti: 'missing' });
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
