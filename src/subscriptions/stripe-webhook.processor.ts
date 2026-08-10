import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import type Stripe from 'stripe';
import { AuditService } from '../audit/audit.service';
import { LeadFinderBillingService } from '../lead-finder-billing/lead-finder-billing.service';
import { STRIPE_WEBHOOK_QUEUE } from '../queue/queue.module';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Consumes events the (already signature-verified) webhook controller
 * enqueues. Default worker concurrency (1) is deliberate, not just
 * unconfigured — processing one event at a time keeps events for the same
 * subscription in the order they were received, which matters since
 * `syncSubscriptionFromStripe` applies whatever state a given event
 * carries directly.
 */
@Processor(STRIPE_WEBHOOK_QUEUE)
export class StripeWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(StripeWebhookProcessor.name);

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly leadFinderBilling: LeadFinderBillingService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job<Stripe.Event>): Promise<void> {
    // Both own a disjoint slice of Stripe events (Directory subscription
    // vs. Lead Finder tier subscription/credit-pack) — each ignores what
    // isn't theirs, so calling both unconditionally is correct, not
    // wasteful duplication.
    await this.subscriptions.handleWebhookEvent(job.data);
    await this.leadFinderBilling.handleWebhookEvent(job.data);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<Stripe.Event>, err: Error): Promise<void> {
    this.logger.error(
      `Webhook job ${job.id} (${job.name}) failed after ${job.attemptsMade} attempt(s): ${err.message}`,
    );
    // Only after every retry is exhausted — a mid-retry failure is normal
    // and would just be noise here. This is the "someone should look at
    // this" signal once BullMQ has given up.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await this.audit.record({
        action: 'billing.webhook_processing_failed',
        targetType: 'StripeEvent',
        targetId: job.data.id,
        metadata: { eventType: job.data.type, error: err.message },
      });
    }
  }
}
