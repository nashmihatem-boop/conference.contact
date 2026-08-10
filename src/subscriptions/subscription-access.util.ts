import { SubscriptionStatus } from '../../generated/prisma/enums';

export interface AccessCheckSubscription {
  status: SubscriptionStatus;
  pastDueSince: Date | null;
}

/**
 * Single source of truth for "does this subscription currently grant
 * product access" — used by SubscriptionGuard, LeadsService, and
 * SubscriptionsService.getStatus so they can never quietly disagree.
 *
 * ACTIVE/TRIALING always grant access. PAST_DUE grants access only within
 * the configured grace period from when it first went past due: Stripe
 * retries a failed card automatically, so cutting access on the very
 * first failure is a bad experience for what's often a transient issue —
 * but indefinite PAST_DUE access isn't a real policy either. Past the
 * grace period, PAST_DUE is treated exactly like no subscription at all.
 */
export function hasActiveAccess(
  subscription: AccessCheckSubscription,
  gracePeriodDays: number,
): boolean {
  if (subscription.status === 'ACTIVE' || subscription.status === 'TRIALING') {
    return true;
  }
  if (subscription.status === 'PAST_DUE') {
    // Defensive: a PAST_DUE row should always have this set (see
    // markPastDueIfNeeded in subscriptions.service.ts) — but if it's ever
    // missing, don't punish the customer for our own bookkeeping gap.
    if (!subscription.pastDueSince) return true;
    const graceEndsAt = new Date(
      subscription.pastDueSince.getTime() +
        gracePeriodDays * 24 * 60 * 60 * 1000,
    );
    return new Date() < graceEndsAt;
  }
  return false;
}

/** Whole days since pastDueSince, floored — 0 on the first day, not negative once it's actually past due. */
export function daysPastDue(pastDueSince: Date | null): number | null {
  if (!pastDueSince) return null;
  const elapsedMs = Date.now() - pastDueSince.getTime();
  return Math.max(0, Math.floor(elapsedMs / (24 * 60 * 60 * 1000)));
}

/**
 * The Lead Directory is kept as a permanent perk of having paid at least
 * once and chosen to leave on your own terms — CANCELED (not PAST_DUE
 * lapsing from a failed payment) is what distinguishes the two. The AI
 * Lead Finder is the ongoing-cost feature (real Apollo credits per
 * enrichment) and stays behind hasActiveAccess regardless of this.
 */
export function hasDirectoryAccess(
  subscription: AccessCheckSubscription,
  gracePeriodDays: number,
): boolean {
  return (
    hasActiveAccess(subscription, gracePeriodDays) ||
    subscription.status === 'CANCELED'
  );
}
