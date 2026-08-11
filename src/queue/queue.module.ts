import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

export const EMAIL_QUEUE = 'email';
export const STRIPE_WEBHOOK_QUEUE = 'stripe-webhook';
export const APOLLO_SEARCH_QUEUE = 'apollo-search';
export const RENEWAL_REMINDER_QUEUE = 'renewal-reminder';
// Cold-outreach prospect invites (single or bulk) — a separate queue from
// EMAIL_QUEUE and rate-limited (see BulkEmailProcessor) so a 30,000-email
// campaign can never delay a time-sensitive transactional send (a login
// code, a password reset) sitting behind it in the same worker.
export const BULK_EMAIL_QUEUE = 'bulk-email';
// Drives the once-daily drip job that sends a capped batch out of
// ProspectInviteQueue — see ProspectCampaignModule. Separate from
// BULK_EMAIL_QUEUE itself (which still does the actual sending/rate
// limiting); this queue only ever holds one recurring 'drip' job.
export const PROSPECT_CAMPAIGN_QUEUE = 'prospect-campaign';

/** Injection token for the plain ioredis client — for simple cache-style commands (GET/SET/EXISTS), not queue work. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * BullMQ's `connection` option accepts a live ioredis instance directly
 * (see `ConnectionOptions` in bullmq's types). `maxRetriesPerRequest: null`
 * is a hard BullMQ requirement for any connection used by a Worker —
 * Workers run their own blocking-command retry loop and ioredis's default
 * retry-then-throw behavior fights it.
 *
 * REDIS_CLIENT is a second, plain connection (no such requirement) for
 * everything that isn't a queue — right now that's TokenRevocationService.
 * Two lightweight connections to one Redis instance is normal; sharing
 * BullMQ's connection for unrelated commands would just couple two things
 * that don't need to know about each other.
 *
 * @Global so any module can inject REDIS_CLIENT (or use BullModule's own
 * registerQueue) without importing this module explicitly — matches how
 * CommonModule/PrismaModule are wired.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: new IORedis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
        }),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Completed jobs are pure noise once done; failures stay around
          // longer since a persistent failure (bad Resend key, Stripe
          // outage) is exactly what someone would come here to diagnose.
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      }),
    }),
  ],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new IORedis(config.getOrThrow<string>('REDIS_URL')),
    },
  ],
  exports: [BullModule, REDIS_CLIENT],
})
export class QueueModule {}
