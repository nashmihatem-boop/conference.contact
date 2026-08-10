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
import { UsersService } from '../users/users.service';
import {
  daysPastDue,
  hasActiveAccess,
  hasDirectoryAccess,
} from './subscription-access.util';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
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

  // ── Plans ────────────────────────────────────────────────────────────

  listPlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { amountCents: 'asc' },
    });
  }

  // ── Lead Finder credit packs ─────────────────────────────────────────

  listCreditPacks() {
    return this.prisma.creditPack.findMany({
      where: { isActive: true },
      orderBy: { credits: 'asc' },
    });
  }

  /**
   * A one-time (mode: 'payment') checkout for topping up Lead Finder
   * credits — deliberately a separate method from createCheckoutSession
   * rather than a branch inside it: none of that method's subscription
   * bookkeeping (blocking a second active subscription, cancelling a
   * grace-period-expired one) applies here. A user can buy credits
   * regardless of their subscription status.
   */
  async createCreditsCheckoutSession(
    userId: string,
    packSlug: string,
    quantity: number,
  ): Promise<{ url: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('Account not found');

    const pack = await this.prisma.creditPack.findUnique({
      where: { slug: packSlug },
    });
    if (!pack || !pack.isActive) {
      throw new NotFoundException('Credit pack not found');
    }

    const customerId = await this.stripeCustomer.getOrCreateStripeCustomer(
      user.id,
      user.email,
      user.fullName,
    );

    const session = await this.stripe.client.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: pack.stripePriceId, quantity }],
      success_url: `${this.frontendUrl}/leads-finder?credits=success`,
      cancel_url: `${this.frontendUrl}/leads-finder?credits=cancelled`,
      // Read back in handleWebhookEvent's checkout.session.completed case —
      // a payment-mode session has no subscription object to derive this
      // from, so the total credits granted has to be stamped here.
      metadata: {
        userId: user.id,
        packId: pack.id,
        credits: String(pack.credits * quantity),
      },
    });

    if (!session.url) {
      throw new BadRequestException('Stripe did not return a checkout URL');
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.credits_checkout_started',
      metadata: { packId: pack.id, packSlug: pack.slug, quantity },
    });

    return { url: session.url };
  }

  // ── Checkout / portal ────────────────────────────────────────────────

  async createCheckoutSession(
    userId: string,
    planSlug: string,
  ): Promise<{ url: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('Account not found');

    const plan = await this.prisma.plan.findUnique({
      where: { slug: planSlug },
    });
    if (!plan || !plan.isActive) throw new NotFoundException('Plan not found');

    const existing = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing && hasActiveAccess(existing, this.gracePeriodDays)) {
      throw new BadRequestException(
        'You already have a subscription. Use the billing portal to change or cancel it.',
      );
    }
    if (existing) {
      // Grace period expired — from the customer's side this is "no
      // subscription, please subscribe again", but the old one is still a
      // live object in Stripe that would otherwise keep failing to bill
      // them alongside the new one. Cancel it immediately rather than
      // leaving two subscriptions attached to the same customer.
      await this.stripe.client.subscriptions.cancel(
        existing.stripeSubscriptionId,
      );
      await this.prisma.subscription.update({
        where: { id: existing.id },
        data: { status: 'CANCELED', cancelAtPeriodEnd: false },
      });
    }

    const customerId = await this.stripeCustomer.getOrCreateStripeCustomer(
      user.id,
      user.email,
      user.fullName,
    );

    const session = await this.stripe.client.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      // Matches the real frontend routes (single /account page, pricing
      // lives at the homepage's #pricing anchor, not a standalone /pricing
      // route) — found and fixed while actually wiring the frontend to
      // this endpoint, not guessed.
      success_url: `${this.frontendUrl}/account?checkout=success`,
      cancel_url: `${this.frontendUrl}/?checkout=cancelled#pricing`,
      // Displayed directly above Stripe's own submit button — this is what
      // makes the no-refund policy enforceable in a chargeback dispute (US
      // FTC guidance requires the policy be disclosed before purchase, not
      // just buried in the ToS) and is the one place on the whole flow we
      // can't skip, edit around, or forget to keep in sync.
      custom_text: {
        submit: {
          message:
            'All sales are final — this plan is billed $50 every 6 months with no refunds. You can cancel anytime from your account to stop future renewals.',
        },
      },
      // Stripe's Managed Payments (on by default) rejects custom_text
      // outright — the no-refund disclosure above is a real compliance
      // requirement, not the thing to drop, so this is disabled instead.
      managed_payments: { enabled: false },
      // Stamped on both the session and the subscription it creates —
      // checkout.session.completed carries session metadata, but
      // customer.subscription.* events only see the subscription's own
      // metadata, so both need userId/planId to self-describe.
      metadata: { userId: user.id, planId: plan.id },
      subscription_data: { metadata: { userId: user.id, planId: plan.id } },
    });

    if (!session.url) {
      throw new BadRequestException('Stripe did not return a checkout URL');
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.checkout_started',
      metadata: { planId: plan.id, planSlug: plan.slug },
    });

    return { url: session.url };
  }

  async createPortalSession(userId: string): Promise<{ url: string }> {
    const user = await this.users.findById(userId);
    if (!user?.stripeCustomerId) {
      throw new BadRequestException('No billing account yet — subscribe first');
    }

    const portal = await this.stripe.client.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${this.frontendUrl}/account/billing`,
    });

    return { url: portal.url };
  }

  // ── Status / cancellation ────────────────────────────────────────────

  async getStatus(userId: string) {
    // Staff accounts manage and support the product, not pay for it —
    // hasDirectoryAccess is forced true regardless of subscription state,
    // same principle as LeadsService.isAdminAccount for Lead Finder limits.
    const [subscription, user] = await Promise.all([
      this.prisma.subscription.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
      this.users.findById(userId),
    ]);
    const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
    // See User.adminGrantedDirectoryAccess — a comp independent of the
    // Subscription table, so it forces hasDirectoryAccess the same way the
    // admin-role bypass above does.
    const isComped = user?.adminGrantedDirectoryAccess ?? false;

    if (!subscription) {
      return {
        status: 'NONE' as const,
        hasDirectoryAccess: isAdmin || isComped,
      };
    }

    return {
      status: subscription.status,
      plan: subscription.plan.name,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      hasDirectoryAccess:
        isAdmin ||
        isComped ||
        hasDirectoryAccess(subscription, this.gracePeriodDays),
      daysPastDue: daysPastDue(subscription.pastDueSince),
    };
  }

  async cancel(userId: string): Promise<{ message: string }> {
    // Ordered the same way getStatus() picks "the current" subscription —
    // in normal operation only one ACTIVE/TRIALING/PAST_DUE row can exist
    // per user (createCheckoutSession blocks a second one), but matching
    // the ordering explicitly means the two methods can never disagree
    // about which subscription is "current" if that invariant is ever
    // violated (e.g. a subscription created directly via the Stripe
    // dashboard/API rather than through this app).
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription)
      throw new NotFoundException('No active subscription to cancel');

    await this.stripe.client.subscriptions.update(
      subscription.stripeSubscriptionId,
      {
        cancel_at_period_end: true,
      },
    );

    // Optimistic local update for immediate UI feedback — the webhook
    // (customer.subscription.updated) reconciles moments later and is the
    // actual source of truth if these ever disagree.
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.subscription_cancel_requested',
      targetId: subscription.id,
    });

    return {
      message:
        'Your subscription will remain active until the end of the current billing period.',
    };
  }

  /**
   * Undoes a pending cancellation on the same subscription — not a new
   * checkout. While cancelAtPeriodEnd is true the subscription is still
   * ACTIVE, so createCheckoutSession would just reject a second one; the
   * only real action available is un-setting the flag Stripe already has.
   */
  async resume(userId: string): Promise<{ message: string }> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        cancelAtPeriodEnd: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) {
      throw new NotFoundException('No pending cancellation to undo');
    }

    await this.stripe.client.subscriptions.update(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: false },
    );

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: false },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.subscription_resumed',
      targetId: subscription.id,
    });

    return { message: 'Your subscription will continue renewing as normal.' };
  }

  // ── Stripe → local sync ──────────────────────────────────────────────

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        if (session.mode === 'payment') {
          await this.handleCreditsCheckoutCompleted(session);
          break;
        }

        if (session.mode !== 'subscription' || !session.subscription) break;
        const stripeSubscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
        const stripeSub =
          await this.stripe.client.subscriptions.retrieve(stripeSubscriptionId);
        await this.syncSubscriptionFromStripe(stripeSub);
        await this.sendSubscriptionConfirmedEmail(stripeSub);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.resumed': {
        await this.syncSubscriptionFromStripe(event.data.object);
        break;
      }

      case 'customer.subscription.deleted': {
        await this.prisma.subscription.updateMany({
          where: { stripeSubscriptionId: event.data.object.id },
          data: { status: 'CANCELED' },
        });
        break;
      }

      case 'invoice.paid': {
        await this.syncInvoiceFromStripe(event.data.object, 'PAID');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await this.syncInvoiceFromStripe(invoice, 'OPEN');
        const subscriptionId =
          invoice.parent?.subscription_details?.subscription;
        if (subscriptionId) {
          const id =
            typeof subscriptionId === 'string'
              ? subscriptionId
              : subscriptionId.id;
          await this.markPastDue(id);
        }
        break;
      }

      default:
        this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  /**
   * A one-time credit-pack purchase completing — the money already
   * cleared by the time this event fires, so this only ever grants
   * credits (never reverses them; Stripe refunds are handled manually via
   * the dashboard, matching how invoice disputes are handled elsewhere in
   * this app).
   */
  private async handleCreditsCheckoutCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const userId = session.metadata?.userId;
    const credits = session.metadata?.credits
      ? parseInt(session.metadata.credits, 10)
      : NaN;

    if (!userId || !Number.isFinite(credits) || credits <= 0) {
      this.logger.warn(
        `checkout.session.completed (payment mode) ${session.id} missing/invalid userId or credits metadata — skipping`,
      );
      return;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { leadFinderCredits: { increment: credits } },
    });

    await this.prisma.creditGrant.create({
      data: {
        userId,
        credits,
        source: 'CREDIT_PACK_PURCHASE',
        amountPaidCents: session.amount_total ?? undefined,
        stripeReference: session.id,
      },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.credits_purchased',
      metadata: { credits, sessionId: session.id },
    });
  }

  private async syncSubscriptionFromStripe(
    stripeSub: Stripe.Subscription,
  ): Promise<void> {
    // A Lead Finder tier subscription, not a Directory one — same webhook
    // event types fire for both since both are mode: 'subscription', but
    // LeadFinderBillingService (called separately by StripeWebhookProcessor
    // for every event) owns these. Stamped on subscription_data.metadata
    // at checkout time — see LeadFinderBillingService.createCheckoutSession.
    if (stripeSub.metadata?.kind === 'lead_finder_tier') return;

    const userId = stripeSub.metadata?.userId;
    const planId = stripeSub.metadata?.planId;

    // Fetched up front (not just in the fallback branch below) so the
    // normal upsert path also knows whether this subscription was already
    // mid-grace-period — mapStripeSubToUpdate needs that to decide whether
    // to keep the existing pastDueSince or start a fresh one.
    const existing = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId: stripeSub.id },
      select: { id: true, pastDueSince: true },
    });

    if (!userId || !planId) {
      // Falls back to matching by stripeSubscriptionId for events that
      // don't carry our metadata (shouldn't normally happen since we stamp
      // metadata on every subscription we create, but a manually-created
      // test-mode subscription in the Stripe dashboard wouldn't have it).
      if (!existing) {
        this.logger.warn(
          `Received subscription event for ${stripeSub.id} with no userId/planId metadata and no matching local row — skipping`,
        );
        return;
      }
      await this.prisma.subscription.update({
        where: { id: existing.id },
        data: this.mapStripeSubToUpdate(stripeSub, existing.pastDueSince),
      });
      return;
    }

    const item = stripeSub.items.data[0];
    const status = this.mapStripeStatus(stripeSub.status);
    try {
      await this.prisma.subscription.upsert({
        where: { stripeSubscriptionId: stripeSub.id },
        create: {
          userId,
          planId,
          stripeCustomerId:
            typeof stripeSub.customer === 'string'
              ? stripeSub.customer
              : stripeSub.customer.id,
          stripeSubscriptionId: stripeSub.id,
          status,
          currentPeriodStart: new Date(item.current_period_start * 1000),
          currentPeriodEnd: new Date(item.current_period_end * 1000),
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
          trialEndsAt: stripeSub.trial_end
            ? new Date(stripeSub.trial_end * 1000)
            : null,
          pastDueSince: status === 'PAST_DUE' ? new Date() : null,
        },
        update: this.mapStripeSubToUpdate(
          stripeSub,
          existing?.pastDueSince ?? null,
        ),
      });
    } catch (err) {
      // The DB's partial unique index (one ACTIVE/TRIALING/PAST_DUE row per
      // user — see the schema.prisma comment on Subscription) rejected this
      // write: two checkout sessions raced past createCheckoutSession's
      // check-then-act guard and both reached Stripe, so this subscription
      // is a genuine duplicate of one already live for the same user.
      // Cancelling it immediately (rather than letting the row upsert
      // silently fail and leaving an orphaned, unbilled-for-in-our-DB
      // subscription live in Stripe) is what actually protects the user
      // from being charged twice.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.error(
          `Duplicate active subscription detected for user ${userId} — cancelling redundant Stripe subscription ${stripeSub.id}`,
        );
        await this.stripe.client.subscriptions.cancel(stripeSub.id);
        await this.audit.record({
          actorUserId: userId,
          action: 'billing.duplicate_subscription_prevented',
          targetId: stripeSub.id,
        });
        return;
      }
      throw err;
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'billing.subscription_synced',
      targetId: stripeSub.id,
      metadata: { status },
    });
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
    if (stripeSub.metadata?.kind === 'lead_finder_tier') return;
    const userId = stripeSub.metadata?.userId;
    const planId = stripeSub.metadata?.planId;
    if (!userId || !planId) return;

    const [user, plan] = await Promise.all([
      this.users.findById(userId),
      this.prisma.plan.findUnique({ where: { id: planId } }),
    ]);
    if (!user || !plan) return;

    const item = stripeSub.items.data[0];
    await this.email.sendSubscriptionConfirmed(
      user.email,
      plan.name,
      plan.amountCents,
      new Date(item.current_period_end * 1000),
    );
  }

  private mapStripeSubToUpdate(
    stripeSub: Stripe.Subscription,
    currentPastDueSince: Date | null,
  ) {
    const item = stripeSub.items.data[0];
    const status = this.mapStripeStatus(stripeSub.status);
    return {
      status,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      trialEndsAt: stripeSub.trial_end
        ? new Date(stripeSub.trial_end * 1000)
        : null,
      // Never overwritten by a repeat failure within the same past-due
      // streak — the grace period counts from the first failure, and
      // clears the moment status resolves to anything but PAST_DUE.
      pastDueSince:
        status === 'PAST_DUE' ? (currentPastDueSince ?? new Date()) : null,
    };
  }

  /** Sets PAST_DUE + stamps pastDueSince only if it isn't already set — called from invoice.payment_failed, which can fire independently of a subscription.updated event. Sends the payment-failed email only on this first transition, not on every Stripe retry. */
  private async markPastDue(stripeSubscriptionId: string): Promise<void> {
    const existing = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: {
        id: true,
        pastDueSince: true,
        user: { select: { email: true } },
        plan: { select: { name: true } },
      },
    });
    if (!existing) return;
    const isFirstFailure = !existing.pastDueSince;
    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: {
        status: 'PAST_DUE',
        pastDueSince: existing.pastDueSince ?? new Date(),
      },
    });
    if (isFirstFailure) {
      await this.email.sendPaymentFailed(
        existing.user.email,
        existing.plan.name,
        this.gracePeriodDays,
      );
    }
  }

  private async syncInvoiceFromStripe(
    invoice: Stripe.Invoice,
    status: 'PAID' | 'OPEN',
  ): Promise<void> {
    const subscriptionRef = invoice.parent?.subscription_details?.subscription;
    if (!subscriptionRef) return; // not a subscription invoice (e.g. a one-off) — nothing to link it to

    const stripeSubscriptionId =
      typeof subscriptionRef === 'string'
        ? subscriptionRef
        : subscriptionRef.id;
    const localSub = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
    });
    if (!localSub) {
      // Not unknown, just not ours — a Lead Finder tier invoice routes
      // through the same webhook but is owned by LeadFinderBillingService.
      // Only genuinely unmatched subscriptions are worth a warning.
      const isLeadFinderTier =
        await this.prisma.leadFinderSubscription.findUnique({
          where: { stripeSubscriptionId },
          select: { id: true },
        });
      if (!isLeadFinderTier) {
        this.logger.warn(
          `Invoice ${invoice.id} references unknown subscription ${stripeSubscriptionId}`,
        );
      }
      return;
    }

    await this.prisma.invoice.upsert({
      where: { stripeInvoiceId: invoice.id },
      create: {
        subscriptionId: localSub.id,
        stripeInvoiceId: invoice.id,
        amountCents: invoice.amount_paid || invoice.amount_due,
        currency: invoice.currency,
        status,
        pdfUrl: invoice.invoice_pdf,
        paidAt: status === 'PAID' ? new Date() : null,
      },
      update: {
        status,
        amountCents: invoice.amount_paid || invoice.amount_due,
        pdfUrl: invoice.invoice_pdf,
        paidAt: status === 'PAID' ? new Date() : null,
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
