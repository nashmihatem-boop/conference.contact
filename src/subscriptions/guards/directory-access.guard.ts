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
import { hasDirectoryAccess } from '../subscription-access.util';

/**
 * Protects the Lead Directory specifically — a deliberately looser gate
 * than the stricter hasActiveAccess check. Anyone who has ever paid and
 * chose to cancel on their own terms keeps this permanently (see
 * hasDirectoryAccess). The Lead Finder has no equivalent route guard — it's
 * gated purely by credit balance inside LeadsService (see
 * hasPaidLeadFinderTier there).
 */
@Injectable()
export class DirectoryAccessGuard implements CanActivate {
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
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (
      !subscription ||
      !hasDirectoryAccess(subscription, this.gracePeriodDays)
    ) {
      throw new ForbiddenException(
        'An active or previous subscription is required for this feature',
      );
    }
    return true;
  }
}
