import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * Thin wrapper around the Stripe SDK client. Deliberately doesn't grow
 * business-logic methods (creating a customer, syncing a subscription,
 * ...) — that belongs in SubscriptionsService, which uses `client`
 * directly. This class exists to centralize construction (one client,
 * one place the secret key is read) and webhook signature verification,
 * which needs the raw request body and shouldn't be duplicated.
 */
@Injectable()
export class StripeService {
  readonly client: Stripe;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.client = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'));
    this.webhookSecret = config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  }

  /** Throws if the signature doesn't match — never trust a webhook body without this. */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.client.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
  }
}
