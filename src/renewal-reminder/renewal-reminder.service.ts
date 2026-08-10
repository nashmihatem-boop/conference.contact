import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

const REMINDER_WINDOW_START_DAYS = 6;
const REMINDER_WINDOW_END_DAYS = 8;

/**
 * Sends the "renews in 7 days" email promised in the pricing FAQ and ToS —
 * without it, a $50/6-month or Lead Finder renewal is a silent charge,
 * which is exactly what a no-refund policy can't afford (it's the main
 * chargeback defense once a customer disputes a charge they say surprised
 * them). A 2-day-wide window (6-8 days out), not an exact "= 7 days",
 * because this runs once a day — an exact match would miss subscriptions
 * whose renewal time-of-day falls on the wrong side of when the job runs.
 * renewalReminderSentForPeriodEnd is what prevents a second email on day 7
 * from the same run window, or on every subsequent daily scan until the
 * cycle actually rolls over.
 */
@Injectable()
export class RenewalReminderService {
  private readonly logger = new Logger(RenewalReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async sendDueReminders(): Promise<{ sent: number }> {
    const now = Date.now();
    const windowStart = new Date(
      now + REMINDER_WINDOW_START_DAYS * 24 * 60 * 60 * 1000,
    );
    const windowEnd = new Date(
      now + REMINDER_WINDOW_END_DAYS * 24 * 60 * 60 * 1000,
    );

    let sent = 0;

    const directorySubs = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'TRIALING'] },
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { gte: windowStart, lte: windowEnd },
      },
      include: { user: { select: { email: true } }, plan: true },
    });
    for (const sub of directorySubs) {
      if (
        sub.renewalReminderSentForPeriodEnd?.getTime() ===
        sub.currentPeriodEnd.getTime()
      ) {
        continue;
      }
      try {
        await this.email.sendRenewalReminder(
          sub.user.email,
          sub.plan.name,
          sub.currentPeriodEnd,
          sub.plan.amountCents,
        );
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: { renewalReminderSentForPeriodEnd: sub.currentPeriodEnd },
        });
        sent += 1;
      } catch (err) {
        this.logger.error(
          `Failed to send renewal reminder for subscription ${sub.id}: ${(err as Error).message}`,
        );
      }
    }

    const leadFinderSubs = await this.prisma.leadFinderSubscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'TRIALING'] },
        cancelAtPeriodEnd: false,
        currentPeriodEnd: { gte: windowStart, lte: windowEnd },
      },
      include: { user: { select: { email: true } }, tier: true },
    });
    for (const sub of leadFinderSubs) {
      if (
        sub.renewalReminderSentForPeriodEnd?.getTime() ===
        sub.currentPeriodEnd.getTime()
      ) {
        continue;
      }
      try {
        await this.email.sendRenewalReminder(
          sub.user.email,
          `Lead Finder ${sub.tier.name}`,
          sub.currentPeriodEnd,
          sub.tier.amountCents,
        );
        await this.prisma.leadFinderSubscription.update({
          where: { id: sub.id },
          data: { renewalReminderSentForPeriodEnd: sub.currentPeriodEnd },
        });
        sent += 1;
      } catch (err) {
        this.logger.error(
          `Failed to send renewal reminder for Lead Finder subscription ${sub.id}: ${(err as Error).message}`,
        );
      }
    }

    if (sent > 0) {
      this.logger.log(`Sent ${sent} renewal reminder email(s).`);
    }
    return { sent };
  }
}
