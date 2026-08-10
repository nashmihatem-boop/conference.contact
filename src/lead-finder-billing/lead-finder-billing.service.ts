import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import { AuditService } from '../audit/audit.service';
import { StripeCustomerService } from '../billing/stripe-customer.service';
import { StripeService } from '../billing/stripe.service';
import { EmailService } from '../email/email.service';
import { Prisma } from '../../generated/prisma/client';
import { SubscriptionStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { daysPastDue } from '../subscriptions/subscription-access.util';
import { UsersService } from '../users/users.service';

/**
 * Lead Finder's own allowance ladder — deliberately independent of
 * SubscriptionsService (the $50/6-month Directory plan). Directory access
 * is "pay once, keep forever"; Lead Finder's real cost is per-enrichment
 * (Apollo), so it has its own recurring tiers instead, each topping up
 * User.leadFinderCredits every billing cycle. Shares one Stripe Customer
 * per User with the Directory plan (via StripeCustomerService) so a single
 * billing-portal session manages both.
 */
@Injectable()
export class LeadFinderBillingService {
  private readonly logger = new Logger(LeadFinderBillingService.name);
  private readonly frontendUrl: string;
  private readonly gracePeriodDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly stripeCustomer: StripeCustomerService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {
    this.frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    this.gracePeriodDays = this.config.get<number>(
      'PAYMENT_GRACE_PERIOD_DAYS',
      7,
    );
  }

  listTiers() {
    return this.prisma.leadFinderTier.findMany({
      where: { isActive: true },
      orderBy: { amountCents: 'asc' },
    });
  }

  async getStatus(userId: string) {
    const subscription = await this.prisma.leadFinderSubscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
      include: { tier: true },
    });

    if (!subscription) {
      return { tierSlug: 'free', status: 'NONE' as const };
    }

    return {
      tierSlug: subscription.tier.slug,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      daysPastDue: daysPastDue(subscription.pastDueSince),
    };
  }

  async createCheckoutSession(
    userId: string,
    tierSlug: string,
  ): Promise<{ url: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('Account not found');

    const tier = await this.prisma.leadFinderTier.findUnique({
      where: { slug: tierSlug },
    });
    if (!tier || !tier.isActive || !tier.recurring || !tier.stripePriceId) {
      throw new BadRequestException('This plan is not available for checkout');
    }

    const existing = await this.prisma.leadFinderSubscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    });
    if (existing) {
      throw new BadRequestException(
        'You already have a Lead Finder plan. Use the billing portal to change or cancel it.',
      );
    }

    const customerId = await this.stripeCustomer.getOrCreateStripeCustomer(
      user.id,
      user.email,
      user.fullName,
    );

    const session = await this.stripe.client.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: tier.stripePriceId, quantity: 1 }],
      success_url: `${this.frontendUrl}/leads-finder?tier=success`,
      cancel_url: `${this.frontendUrl}/leads-finder?tier=cancelled`,
      // Same disclosure requirement as SubscriptionsService.createCheckoutSession — see its comment.
      custom_text: {
        submit: {
          message: `All sales are final — this plan is billed $${(tier.amountCents / 100).toFixed(2).replace(/\.00$/, '')} every month with no refunds. You can cancel anytime from your account to stop future renewals.`,
        },
      },
      // Same Managed Payments conflict as SubscriptionsService.createCheckoutSession — see its comment.
      managed_payments: { enabled: false },
      // "kind" is what tells the shared webhook handler this subscription
      // belongs to LeadFinderBillingService, not SubscriptionsService —
      // both process every event; each ignores what isn't theirs.
      metadata: { userId: user.id, tierId: tier.id, kind: 'lead_finder_tier' },
      subscription_data: {
        metadata: {
          userId: user.id,
          tierId: tier.id,
          kind: 'lead_finder_tier',
        },
      },
    });

    if (!session.url) {
      throw new BadRequestException('Stripe did not return a checkout URL');
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.lead_finder_checkout_started',
      metadata: { tierId: tier.id, tierSlug: tier.slug },
    });

    return { url: session.url };
  }

  async cancel(userId: string): Promise<{ message: string }> {
    const subscription = await this.prisma.leadFinderSubscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) {
      throw new NotFoundException('No active Lead Finder plan to cancel');
    }

    await this.stripe.client.subscriptions.update(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: true },
    );

    await this.prisma.leadFinderSubscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.lead_finder_cancel_requested',
      targetId: subscription.id,
    });

    return {
      message:
        'Your Lead Finder plan stays active until the end of the current billing period. Credits already granted never expire.',
    };
  }

  // ── Stripe → local sync ──────────────────────────────────────────────
  //
  // Called for every Stripe event alongside SubscriptionsService — each
  // service ignores events that aren't theirs (checked via metadata.kind
  // or, for events with no metadata of their own, by only ever matching
  // rows in its own table).

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) break;
        if (session.metadata?.kind !== 'lead_finder_tier') break;
        const stripeSubscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
        const stripeSub =
          await this.stripe.client.subscriptions.retrieve(stripeSubscriptionId);
        await this.syncFromStripe(stripeSub);
        await this.sendSubscriptionConfirmedEmail(stripeSub);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.resumed': {
        const stripeSub = event.data.object;
        if (stripeSub.metadata?.kind !== 'lead_finder_tier') break;
        await this.syncFromStripe(stripeSub);
        break;
      }

      case 'customer.subscription.deleted': {
        await this.prisma.leadFinderSubscription.updateMany({
          where: { stripeSubscriptionId: event.data.object.id },
          data: { status: 'CANCELED' },
        });
        break;
      }

      case 'invoice.paid': {
        await this.grantMonthlyCredits(event.data.object);
        break;
      }

      default:
        break;
    }
  }

  private async syncFromStripe(stripeSub: Stripe.Subscription): Promise<void> {
    const userId = stripeSub.metadata?.userId;
    const tierId = stripeSub.metadata?.tierId;
    if (!userId || !tierId) {
      this.logger.warn(
        `Lead Finder subscription event for ${stripeSub.id} missing userId/tierId metadata — skipping`,
      );
      return;
    }

    // Fetched up front so a repeat PAST_DUE event (e.g. a retried failed
    // charge) doesn't reset the grace-period clock — same reasoning as
    // SubscriptionsService.syncSubscriptionFromStripe for the Directory
    // plan. Without this, hasPaidLeadFinderTier's PAST_DUE branch would
    // treat every Lead Finder subscription with a failed payment as
    // permanently paid-tier, since pastDueSince would never be set.
    const existing = await this.prisma.leadFinderSubscription.findUnique({
      where: { stripeSubscriptionId: stripeSub.id },
      select: { pastDueSince: true },
    });

    const item = stripeSub.items.data[0];
    const status = this.mapStripeStatus(stripeSub.status);
    const isFirstFailure = status === 'PAST_DUE' && !existing?.pastDueSince;
    const pastDueSince =
      status === 'PAST_DUE' ? (existing?.pastDueSince ?? new Date()) : null;
    try {
      await this.prisma.leadFinderSubscription.upsert({
        where: { stripeSubscriptionId: stripeSub.id },
        create: {
          userId,
          tierId,
          stripeCustomerId:
            typeof stripeSub.customer === 'string'
              ? stripeSub.customer
              : stripeSub.customer.id,
          stripeSubscriptionId: stripeSub.id,
          status,
          currentPeriodStart: new Date(item.current_period_start * 1000),
          currentPeriodEnd: new Date(item.current_period_end * 1000),
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
          pastDueSince,
        },
        update: {
          status,
          currentPeriodStart: new Date(item.current_period_start * 1000),
          currentPeriodEnd: new Date(item.current_period_end * 1000),
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
          pastDueSince,
        },
      });
      if (isFirstFailure) {
        const [user, tier] = await Promise.all([
          this.users.findById(userId),
          this.prisma.leadFinderTier.findUnique({ where: { id: tierId } }),
        ]);
        if (user && tier) {
          await this.email.sendPaymentFailed(
            user.email,
            `Lead Finder ${tier.name}`,
            this.gracePeriodDays,
          );
        }
      }
    } catch (err) {
      // Same DB-level guarantee and same reasoning as
      // SubscriptionsService.syncSubscriptionFromStripe — see the comment
      // there. Applies here to Lead Finder tier subscriptions specifically.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.error(
          `Duplicate active Lead Finder subscription detected for user ${userId} — cancelling redundant Stripe subscription ${stripeSub.id}`,
        );
        await this.stripe.client.subscriptions.cancel(stripeSub.id);
        await this.audit.record({
          actorUserId: userId,
          action: 'billing.duplicate_lead_finder_subscription_prevented',
          targetId: stripeSub.id,
        });
        return;
      }
      throw err;
    }
  }

  /**
   * Only ever called from the checkout.session.completed case — that event
   * fires exactly once per new subscription, unlike this same Stripe
   * subscription object also flowing through customer.subscription.updated
   * on every later renewal, which must never re-send this.
   */
  private async sendSubscriptionConfirmedEmail(
    stripeSub: Stripe.Subscription,
  ): Promise<void> {
    const userId = stripeSub.metadata?.userId;
    const tierId = stripeSub.metadata?.tierId;
    if (!userId || !tierId) return;

    const [user, tier] = await Promise.all([
      this.users.findById(userId),
      this.prisma.leadFinderTier.findUnique({ where: { id: tierId } }),
    ]);
    if (!user || !tier) return;

    const item = stripeSub.items.data[0];
    await this.email.sendSubscriptionConfirmed(
      user.email,
      `AI Lead Finder — ${tier.name}`,
      tier.amountCents,
      new Date(item.current_period_end * 1000),
    );
  }

  /**
   * The real monthly top-up — fires once per successful invoice (first
   * payment and every renewal alike), granting that tier's full monthly
   * allowance. Reads userId/tierId straight from the invoice's own
   * subscription_details.metadata rather than looking up the local
   * LeadFinderSubscription row — Stripe doesn't guarantee event delivery
   * order across event types, so this can't depend on syncFromStripe
   * having already created that row.
   */
  private async grantMonthlyCredits(invoice: Stripe.Invoice): Promise<void> {
    const metadata = invoice.parent?.subscription_details?.metadata;
    if (metadata?.kind !== 'lead_finder_tier') return;

    const userId = metadata.userId;
    const tierId = metadata.tierId;
    if (!userId || !tierId) {
      this.logger.warn(
        `Lead Finder invoice ${invoice.id} missing userId/tierId metadata — skipping credit grant`,
      );
      return;
    }

    const tier = await this.prisma.leadFinderTier.findUnique({
      where: { id: tierId },
    });
    if (!tier) {
      this.logger.warn(
        `Lead Finder invoice ${invoice.id} references unknown tier ${tierId} — skipping credit grant`,
      );
      return;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { leadFinderCredits: { increment: tier.credits } },
    });

    await this.prisma.creditGrant.create({
      data: {
        userId,
        credits: tier.credits,
        source: 'LEAD_FINDER_TIER_GRANT',
        amountPaidCents: invoice.amount_paid,
        stripeReference: invoice.id,
      },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.lead_finder_credits_granted',
      metadata: {
        tierSlug: tier.slug,
        credits: tier.credits,
        invoiceId: invoice.id,
      },
    });
  }

  private mapStripeStatus(
    status: Stripe.Subscription.Status,
  ): SubscriptionStatus {
    switch (status) {
      case 'trialing':
        return 'TRIALING';
      case 'active':
        return 'ACTIVE';
      case 'past_due':
      case 'unpaid':
      case 'paused':
        return 'PAST_DUE';
      case 'canceled':
        return 'CANCELED';
      case 'incomplete':
      case 'incomplete_expired':
      default:
        return 'EXPIRED';
    }
  }
}
