import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE } from '../queue/queue.module';
import { withTimeout } from '../queue/with-timeout.util';

// These jobs carry a raw, single-use secret (a verification/reset token, or
// a login code) in plaintext — the whole reason it's hashed before ever
// touching the database. QueueModule's global default keeps a *failed* job
// around for 7 days for debugging, which would otherwise mean that same
// raw secret sits readable in Redis for a week if a send fails. An hour is
// still enough to notice and investigate a failure (the @OnWorkerEvent
// ('failed') log line is the actual failure-visibility mechanism, not
// manually inspecting job payloads) without leaving a live secret parked
// far longer than its own short expiry window.
const SHORT_FAILURE_RETENTION = { removeOnFail: { age: 60 * 60 } };

// queue.add() waits forever if Redis is unreachable (see with-timeout.util's
// doc comment) — bounding it here is what stops "Redis is down" from also
// meaning "registration never responds."
const ENQUEUE_TIMEOUT_MS = 3_000;

/**
 * A thin producer — every method here just enqueues a job and returns.
 * EmailProcessor (same module) is the actual worker holding the Resend
 * client. This means a registration/login/etc. request never blocks on
 * Resend's API, and a transient Resend outage is retried by BullMQ
 * (configured in QueueModule) instead of being a lost, unlogged email.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly frontendUrl: string;
  private readonly isProduction: boolean;

  constructor(
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {
    this.frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    this.isProduction = this.config.get('NODE_ENV') === 'production';
  }

  /** Fired alongside the verification email on register() — a separate, non-blocking send so a Resend hiccup on one never affects the other. */
  async sendWelcomeEmail(to: string, fullName: string): Promise<void> {
    await this.enqueue('welcome', { to, fullName });
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
    this.logDevLink('Email verification link', to, link);
    await this.enqueue('verification', { to, token });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
    this.logDevLink('Password reset link', to, link);
    await this.enqueue('password-reset', { to, token });
  }

  /** New-device login verification, when the user doesn't have 2FA enabled. */
  async sendDeviceVerificationCode(to: string, code: string): Promise<void> {
    this.logDevLink('Device verification code', to, code);
    await this.enqueue('device-code', { to, code });
  }

  /** /contact form submissions — delivered to SUPPORT_EMAIL, reply-to set to the submitter. */
  async sendContactFormMessage(
    name: string,
    fromEmail: string,
    reason: string,
    message: string,
  ): Promise<void> {
    await this.enqueue('contact-form', { name, fromEmail, reason, message });
  }

  /** An admin's reply to a /contact submission — goes to the original sender's address, quoting what they sent. */
  async sendContactMessageReply(
    to: string,
    name: string,
    originalMessage: string,
    replyMessage: string,
  ): Promise<void> {
    await this.enqueue('contact-reply', {
      to,
      name,
      originalMessage,
      replyMessage,
    });
  }

  /** A colleague invited to sign up for their own account — never grants access to the inviter's subscription. */
  async sendInviteEmail(to: string, inviterName: string): Promise<void> {
    await this.enqueue('invite', { to, inviterName });
  }

  /**
   * Sent ~7 days before a subscription renews — the main dispute defense
   * for a recurring charge with no refund policy (see
   * RenewalReminderService). `productLabel` distinguishes the Directory
   * plan from a Lead Finder tier, since both are recurring subscriptions
   * that renew independently of each other.
   */
  async sendRenewalReminder(
    to: string,
    productLabel: string,
    renewalDate: Date,
    amountCents: number,
  ): Promise<void> {
    await this.enqueue('renewal-reminder', {
      to,
      productLabel,
      renewalDate: renewalDate.toISOString(),
      amountCents,
    });
  }

  /**
   * Fires exactly once — from checkout.session.completed, the moment a new
   * subscription is actually paid for. Distinct from sendRenewalReminder
   * (sent *before* a future charge) and from the sync logic that also runs
   * on every later renewal/update, which must never re-fire this.
   */
  async sendSubscriptionConfirmed(
    to: string,
    productLabel: string,
    amountCents: number,
    renewsAt: Date,
  ): Promise<void> {
    await this.enqueue('subscription-confirmed', {
      to,
      productLabel,
      amountCents,
      renewsAt: renewsAt.toISOString(),
    });
  }

  /**
   * Sent the moment a renewal charge first fails (invoice.payment_failed /
   * a subscription's first transition to PAST_DUE) — without this, a
   * customer's only signal that their card was declined is silently losing
   * access `gracePeriodDays` later, which reads as the product breaking
   * rather than a billing issue they can fix. Fires once per past-due
   * streak (callers only invoke this on the first failure, not every
   * Stripe retry).
   */
  async sendPaymentFailed(
    to: string,
    productLabel: string,
    gracePeriodDays: number,
  ): Promise<void> {
    await this.enqueue('payment-failed', { to, productLabel, gracePeriodDays });
  }

  /**
   * Same resilience property the pre-queue version had: a request that
   * triggers an email (registration, login, ...) must still succeed even
   * if the email infrastructure itself is unavailable — that used to mean
   * a Resend hiccup, now it also covers Redis being unreachable. Either
   * way, log loudly and let the caller's request complete normally rather
   * than fail it for an email that can be requested again.
   */
  private async enqueue(
    name: string,
    data: Record<string, string | number>,
  ): Promise<void> {
    try {
      await withTimeout(
        this.queue.add(name, data, SHORT_FAILURE_RETENTION),
        ENQUEUE_TIMEOUT_MS,
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue "${name}" email job for ${data.to}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Dev-only convenience: the raw token/code is never persisted anywhere
   * (only its hash is), so outside of the real email there is no way to
   * retrieve it for local testing without this. Never runs in production —
   * the whole point of hashing these before storage is that nothing but
   * the recipient's inbox should ever see the raw value. Logged here, at
   * enqueue time, rather than in the processor, so it's visible instantly
   * instead of waiting on a worker pickup.
   */
  private logDevLink(label: string, to: string, value: string): void {
    if (this.isProduction) return;
    this.logger.debug(`[DEV ONLY] ${label} for ${to}: ${value}`);
  }
}
