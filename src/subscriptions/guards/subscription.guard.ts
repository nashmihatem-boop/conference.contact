import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AccessTokenPayload } from '../../auth/types/jwt-payload.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { hasActiveAccess } from '../subscription-access.util';

/**
 * Protects premium-content routes. Runs after JwtAuthGuard (which attaches
 * `request.user`), so apply as `@UseGuards(SubscriptionGuard)` on top of
 * routes that already require auth — it doesn't check auth itself.
 *
 * PAST_DUE is allowed through only within the grace period (see
 * hasActiveAccess) — a failed card charge shouldn't cut off access
 * instantly (Stripe retries automatically, and reacting to the first
 * failure is a bad experience for what's often transient), but past the
 * grace period it's treated the same as no subscription at all.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly gracePeriodDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.gracePeriodDays = this.config.get<number>(
      'PAYMENT_GRACE_PERIOD_DAYS',
      7,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AccessTokenPayload }>();
    const user = request.user;
    if (!user) throw new UnauthorizedException();

    // Staff accounts manage and support the product, not pay for it — same
    // bypass principle as LeadsService.isAdminAccount for Lead Finder
    // limits. Read straight off the JWT (already carries role), no extra
    // DB round-trip needed.
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return true;

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: user.sub,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription || !hasActiveAccess(subscription, this.gracePeriodDays)) {
      throw new ForbiddenException(
        'An active subscription is required for this feature',
      );
    }
    return true;
  }
}
