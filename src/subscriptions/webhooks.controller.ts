import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { Public } from '../auth/decorators/public.decorator';
import { StripeService } from '../billing/stripe.service';
import { STRIPE_WEBHOOK_QUEUE } from '../queue/queue.module';
import { withTimeout } from '../queue/with-timeout.util';

// queue.add() waits forever if Redis is unreachable — bounding it means a
// Redis outage surfaces as a fast 503 (which Stripe retries on its own
// schedule) instead of holding the connection open until Stripe's own
// timeout gives up on it.
const ENQUEUE_TIMEOUT_MS = 3_000;

/**
 * Stripe authenticates this endpoint via the Stripe-Signature header, not a
 * bearer token — hence @Public(). Excluded from Swagger since it's not
 * meant to be called by anything but Stripe.
 *
 * Requires the raw request body (not JSON-parsed) to verify the signature —
 * wired up in main.ts via express.raw() scoped to this exact path, applied
 * before the global JSON body parser.
 *
 * Signature verification stays synchronous here — it's cheap (no network,
 * no DB) and it's the actual authentication for this route, so it has to
 * happen before responding either way. Everything after verification
 * (`handleWebhookEvent`, which does real DB writes) is queued instead of
 * awaited inline — Stripe expects a fast response and retries on timeout,
 * and there's no reason to make Stripe wait on our database.
 */
@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly stripe: StripeService,
    @InjectQueue(STRIPE_WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  @Public()
  @Post('stripe')
  async handleStripeWebhook(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: true }> {
    if (!signature) {
      throw new BadRequestException('Missing Stripe-Signature header');
    }

    const rawBody = req.body as Buffer;
    let event: Stripe.Event;
    try {
      event = this.stripe.constructEvent(rawBody, signature);
    } catch (err) {
      // The real reason (bad secret, tampered payload, expired timestamp)
      // is logged server-side only — the HTTP response stays generic so a
      // caller probing this public endpoint never learns anything about
      // *why* verification failed.
      this.logger.warn(
        `Webhook signature verification failed: ${(err as Error).message}`,
      );
      throw new BadRequestException('Webhook signature verification failed');
    }

    try {
      await withTimeout(this.queue.add(event.type, event), ENQUEUE_TIMEOUT_MS);
    } catch (err) {
      // A non-2xx here is a deliberate signal to Stripe: it retries failed
      // deliveries on its own schedule, which is exactly the right
      // behavior if the queue is briefly unreachable — better than
      // pretending we durably queued an event that we didn't.
      this.logger.error(
        `Could not queue webhook event ${event.type} (${event.id}): ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'Could not queue webhook event for processing',
      );
    }
    return { received: true };
  }
}
