import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectoryAccessGuard } from './directory-access.guard';

function buildContext(user?: { sub: string; role?: string }): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function buildConfig(gracePeriodDays = 7): ConfigService {
  return { get: () => gracePeriodDays } as unknown as ConfigService;
}

describe('DirectoryAccessGuard', () => {
  it('throws UnauthorizedException when no user is on the request', async () => {
    const prisma = {
      subscription: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const guard = new DirectoryAccessGuard(prisma, buildConfig());

    await expect(guard.canActivate(buildContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('bypasses the subscription check entirely for ADMIN and SUPER_ADMIN, without a DB round-trip', async () => {
    const findFirst = jest.fn();
    const prisma = { subscription: { findFirst } } as unknown as PrismaService;
    const guard = new DirectoryAccessGuard(prisma, buildConfig());

    await expect(
      guard.canActivate(buildContext({ sub: 'admin_1', role: 'ADMIN' })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(buildContext({ sub: 'admin_2', role: 'SUPER_ADMIN' })),
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('allows a CANCELED subscription through (permanent Directory access once paid at least once)', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      status: 'CANCELED',
      pastDueSince: null,
    });
    const prisma = { subscription: { findFirst } } as unknown as PrismaService;
    const guard = new DirectoryAccessGuard(prisma, buildConfig());

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1', role: 'USER' })),
    ).resolves.toBe(true);
  });

  it('blocks PAST_DUE once the grace period has expired', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      status: 'PAST_DUE',
      pastDueSince: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    const prisma = { subscription: { findFirst } } as unknown as PrismaService;
    const guard = new DirectoryAccessGuard(prisma, buildConfig(7));

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1', role: 'USER' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('blocks a user with no qualifying subscription row at all', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = { subscription: { findFirst } } as unknown as PrismaService;
    const guard = new DirectoryAccessGuard(prisma, buildConfig());

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1', role: 'USER' })),
    ).rejects.toThrow(ForbiddenException);
  });
});
