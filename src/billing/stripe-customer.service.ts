import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { StripeService } from './stripe.service';

/**
 * One Stripe Customer per User, reused across every product surface that
 * bills them — the $50/6-month Directory plan, Lead Finder tier
 * subscriptions, and one-time credit-pack purchases all share the same
 * customer, which is also what lets a single billing-portal session
 * manage all of it at once.
 */
@Injectable()
export class StripeCustomerService {
  private readonly logger = new Logger(StripeCustomerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly users: UsersService,
  ) {}

  async getOrCreateStripeCustomer(
    userId: string,
    email: string,
    name: string,
  ): Promise<string> {
    const user = await this.users.findById(userId);
    if (user?.stripeCustomerId) return user.stripeCustomerId;

    const customer = await this.stripe.client.customers.create({
      email,
      name,
      metadata: { userId },
    });

    // Guards two near-simultaneous first-checkout requests from the same
    // brand-new user racing past the read above and both reaching here:
    // the conditional WHERE means only whichever write lands first
    // actually sets stripeCustomerId, so the two can never stomp each
    // other. The loser's freshly-created Stripe customer becomes a
    // harmless orphan (nothing else in this app ever references it) —
    // logged so it's visible in monitoring rather than silently discarded,
    // not worth an extra Stripe API call to delete for what should be a
    // rare race.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, stripeCustomerId: null },
      data: { stripeCustomerId: customer.id },
    });

    if (count === 0) {
      const winner = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { stripeCustomerId: true },
      });
      if (winner?.stripeCustomerId) {
        this.logger.warn(
          `Lost a getOrCreateStripeCustomer race for user ${userId} — created orphaned Stripe customer ${customer.id}, using ${winner.stripeCustomerId} instead`,
        );
        return winner.stripeCustomerId;
      }
    }

    return customer.id;
  }
}
