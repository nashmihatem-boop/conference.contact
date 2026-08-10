import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { LeadFinderBillingModule } from '../lead-finder-billing/lead-finder-billing.module';
import { STRIPE_WEBHOOK_QUEUE } from '../queue/queue.module';
import { UsersModule } from '../users/users.module';
import { DirectoryAccessGuard } from './guards/directory-access.guard';
import { SubscriptionGuard } from './guards/subscription.guard';
import { StripeWebhookProcessor } from './stripe-webhook.processor';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [
    BillingModule,
    UsersModule,
    AuditModule,
    EmailModule,
    LeadFinderBillingModule,
    BullModule.registerQueue({ name: STRIPE_WEBHOOK_QUEUE }),
  ],
  controllers: [SubscriptionsController, WebhooksController],
  providers: [
    SubscriptionsService,
    SubscriptionGuard,
    DirectoryAccessGuard,
    StripeWebhookProcessor,
  ],
  exports: [SubscriptionsService, SubscriptionGuard, DirectoryAccessGuard],
})
export class SubscriptionsModule {}
