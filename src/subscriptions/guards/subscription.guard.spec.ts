import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionGuard } from './subscription.guard';

function buildContext(user?: { sub: string }): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function buildConfig(gracePeriodDays = 7): ConfigService {
  return { get: () => gracePeriodDays } as unknown as ConfigService;
}

function buildPrisma(
  subscription: unknown,
  adminGrantedDirectoryAccess = false,
): { prisma: PrismaService; findFirst: jest.Mock; findUnique: jest.Mock } {
  const findFirst = jest.fn().mockResolvedValue(subscription);
  const findUnique = jest
    .fn()
    .mockResolvedValue({ adminGrantedDirectoryAccess });
  const prisma = {
    subscription: { findFirst },
    user: { findUnique },
  } as unknown as PrismaService;
  return { prisma, findFirst, findUnique };
}

describe('SubscriptionGuard', () => {
  it('throws UnauthorizedException when no user is on the request (ran before JwtAuthGuard)', async () => {
    const { prisma } = buildPrisma(null);
    const guard = new SubscriptionGuard(prisma, buildConfig());

    await expect(guard.canActivate(buildContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('allows the request through when an ACTIVE subscription exists', async () => {
    const { prisma, findFirst } = buildPrisma({
      id: 'sub_1',
      status: 'ACTIVE',
      pastDueSince: null,
    });
    const guard = new SubscriptionGuard(prisma, buildConfig());

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1' })),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user_1',
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('allows PAST_DUE through within the grace period (a failed charge should not cut access instantly)', async () => {
    const { prisma } = buildPrisma({
      id: 'sub_1',
      status: 'PAST_DUE',
      pastDueSince: new Date(),
    });
    const guard = new SubscriptionGuard(prisma, buildConfig(7));

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1' })),
    ).resolves.toBe(true);
  });

  it('blocks PAST_DUE once the grace period has expired', async () => {
    const { prisma } = buildPrisma({
      id: 'sub_1',
      status: 'PAST_DUE',
      pastDueSince: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    const guard = new SubscriptionGuard(prisma, buildConfig(7));

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when no qualifying subscription exists (e.g. CANCELED or none at all)', async () => {
    const { prisma } = buildPrisma(null);
    const guard = new SubscriptionGuard(prisma, buildConfig());

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows the request through on an admin-granted comp, even with no subscription at all', async () => {
    const { prisma } = buildPrisma(null, true);
    const guard = new SubscriptionGuard(prisma, buildConfig());

    await expect(
      guard.canActivate(buildContext({ sub: 'user_1' })),
    ).resolves.toBe(true);
  });
});
