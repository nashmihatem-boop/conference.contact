import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Resend } from 'resend';
import { EMAIL_QUEUE } from '../queue/queue.module';

interface WelcomeData {
  to: string;
  fullName: string;
}
interface VerificationData {
  to: string;
  token: string;
}
interface PasswordResetData {
  to: string;
  token: string;
}
interface DeviceCodeData {
  to: string;
  code: string;
}
interface ContactFormData {
  name: string;
  fromEmail: string;
  reason: string;
  message: string;
}
interface ContactReplyData {
  to: string;
  name: string;
  originalMessage: string;
  replyMessage: string;
}
interface InviteData {
  to: string;
  inviterName: string;
}
interface ProspectColdInviteData {
  to: string;
}
interface AdminAccessInviteData {
  to: string;
  grantsDirectoryAccess: string;
  grantsLeadFinderAccess: string;
}
interface ProspectPitchData {
  to: string;
  fullName: string;
}
interface SubscriptionConfirmedData {
  to: string;
  productLabel: string;
  amountCents: number;
  renewsAt: string;
}
interface RenewalReminderData {
  to: string;
  productLabel: string;
  renewalDate: string;
  amountCents: number;
}
interface PaymentFailedData {
  to: string;
  productLabel: string;
  gracePeriodDays: number;
}
interface CancellationScheduledData {
  to: string;
  productLabel: string;
  accessUntil: string;
}

const CONTACT_REASON_LABELS: Record<string, string> = {
  BILLING: 'Billing question',
  ACCOUNT_ISSUE: 'Account issue',
  REMOVE_RECORD: 'Remove my directory record',
  OTHER: 'Other',
};

/** Strips control characters (CR/LF in particular) before user input reaches an email subject line — defense-in-depth against header injection, since a subject isn't HTML-rendered so escapeHtml() doesn't apply there. */
function sanitizeForSubject(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/** Contact-form fields are the only untrusted input interpolated into an email body here — everything else is a server-generated token/code. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Every email shares this shell (logo header, white card, footer) — `body`
 * is just the card's contents, so each email case only ever writes the
 * part that's actually different about it.
 */
function renderEmail(body: string): string {
  return `<div style="background-color:#eeeef0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;">
      <table role="presentation" style="margin:0 auto 28px;" cellpadding="0" cellspacing="0">
        <tr>
          <td style="width:28px;height:28px;background-color:#c3db42;border-radius:7px;text-align:center;vertical-align:middle;">
            <div style="width:16px;height:11px;background-color:#0d1448;border-radius:2px;margin:0 auto;"></div>
          </td>
          <td style="padding-left:9px;font-size:17px;font-weight:800;color:#12152b;">conference<span style="color:#a9c022;">.</span>contact</td>
        </tr>
      </table>
      <div style="background-color:#ffffff;border:1px solid #e2e2e7;border-radius:16px;padding:40px 32px;text-align:center;">
        ${body}
      </div>
      <p style="text-align:center;margin-top:24px;font-size:12px;color:#9395a6;">conference.contact — the verified conference contact directory</p>
    </div>
  </div>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0;font-size:21px;font-weight:800;color:#12152b;line-height:1.35;">${text}</h1>`;
}

function paragraph(text: string): string {
  return `<p style="margin:16px 0 0;font-size:15px;color:#5b5f73;line-height:1.6;">${text}</p>`;
}

function footnote(text: string): string {
  return `<p style="margin:22px 0 0;font-size:13px;color:#9395a6;">${text}</p>`;
}

function ctaButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;margin-top:28px;background-color:#c6e02e;color:#0b1454;font-weight:700;font-size:15px;text-decoration:none;padding:14px 34px;border-radius:999px;">${label}</a>`;
}

/**
 * The actual Resend client lives here, not in EmailService — this is the
 * worker side of the queue EmailService produces onto.
 */
@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);
  private readonly resend: Resend;
  private readonly from: string;
  private readonly frontendUrl: string;
  private readonly supportEmail: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.resend = new Resend(this.config.getOrThrow<string>('RESEND_API_KEY'));
    this.from = this.config.getOrThrow<string>('RESEND_FROM_EMAIL');
    this.frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    this.supportEmail = this.config.getOrThrow<string>('SUPPORT_EMAIL');
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'welcome': {
        const { to, fullName } = job.data as WelcomeData;
        const firstName = escapeHtml(
          fullName.trim().split(/\s+/)[0] || 'there',
        );
        const link = `${this.frontendUrl}/account`;
        await this.send(
          to,
          'Welcome to conference.contact',
          renderEmail(
            heading(`Welcome, ${firstName}`) +
              paragraph(
                "Your account is ready. You've got 100 free credits to try AI Lead Finder right away — no subscription needed to start.",
              ) +
              ctaButton(link, 'Go to your account →') +
              footnote(
                'Questions about getting started? Just reply to this email.',
              ),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'verification': {
        const { to, token } = job.data as VerificationData;
        const link = `${this.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
        await this.send(
          to,
          'Verify your email — conference.contact',
          renderEmail(
            heading('Verify your email') +
              paragraph(
                'Confirm your email to finish setting up your conference.contact account.',
              ) +
              ctaButton(link, 'Verify email →') +
              footnote(
                "This link expires in 24 hours. If you didn't create an account, you can ignore this email.",
              ),
          ),
        );
        return;
      }
      case 'password-reset': {
        const { to, token } = job.data as PasswordResetData;
        const link = `${this.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await this.send(
          to,
          'Reset your password — conference.contact',
          renderEmail(
            heading('Reset your password') +
              paragraph(
                'We received a request to reset your conference.contact password.',
              ) +
              ctaButton(link, 'Reset password →') +
              footnote(
                "This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.",
              ),
          ),
        );
        return;
      }
      case 'device-code': {
        const { to, code } = job.data as DeviceCodeData;
        await this.send(
          to,
          "Confirm it's you — conference.contact",
          renderEmail(
            heading("Confirm it's you") +
              paragraph(
                "We noticed a login from a device we don't recognize.",
              ) +
              `<p style="margin:24px 0 0;font-size:32px;font-weight:800;letter-spacing:6px;color:#0b1454;">${code}</p>` +
              footnote(
                "Enter this code to finish signing in. It expires in 10 minutes. If this wasn't you, change your password immediately.",
              ),
          ),
        );
        return;
      }
      case 'contact-form': {
        const { name, fromEmail, reason, message } =
          job.data as ContactFormData;
        const reasonLabel = CONTACT_REASON_LABELS[reason] ?? reason;
        await this.send(
          this.supportEmail,
          `Contact form (${reasonLabel}): ${sanitizeForSubject(name)}`,
          renderEmail(
            heading('New contact form message') +
              `<div style="margin-top:20px;text-align:left;font-size:14px;color:#5b5f73;line-height:1.6;">
                 <p style="margin:0;"><strong>From:</strong> ${escapeHtml(name)} (${escapeHtml(fromEmail)})</p>
                 <p style="margin:8px 0 0;"><strong>Reason:</strong> ${escapeHtml(reasonLabel)}</p>
                 <p style="margin:16px 0 0;white-space:pre-wrap;">${escapeHtml(message)}</p>
               </div>`,
          ),
          fromEmail,
        );
        return;
      }
      case 'contact-reply': {
        const { to, name, originalMessage, replyMessage } =
          job.data as ContactReplyData;
        const firstName = escapeHtml(name.trim().split(/\s+/)[0] || 'there');
        await this.send(
          to,
          'Re: your message to conference.contact',
          renderEmail(
            heading(`Hi ${firstName},`) +
              `<div style="margin-top:16px;text-align:left;font-size:15px;color:#5b5f73;line-height:1.6;white-space:pre-wrap;">${escapeHtml(replyMessage)}</div>` +
              `<div style="margin-top:28px;padding-top:20px;border-top:1px solid #e2e2e7;text-align:left;">
                 <p style="margin:0;font-size:12px;font-weight:700;color:#9395a6;text-transform:uppercase;letter-spacing:0.03em;">Your original message</p>
                 <p style="margin:8px 0 0;font-size:13px;color:#9395a6;line-height:1.6;white-space:pre-wrap;">${escapeHtml(originalMessage)}</p>
               </div>` +
              footnote('Questions? Just reply to this email.'),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'invite': {
        const { to, inviterName } = job.data as InviteData;
        const link = `${this.frontendUrl}/signup?email=${encodeURIComponent(to)}`;
        const name = escapeHtml(inviterName);
        await this.send(
          to,
          `${name} invited you to conference.contact`,
          renderEmail(
            heading(`${name} invited you to conference.contact`) +
              paragraph(
                'A hand-verified directory of B2B conference contacts, with an AI tool that finds and enriches new leads live.',
              ) +
              ctaButton(link, 'Create your account →') +
              footnote(
                "Full Access is $50 every 6 months, rate locked in, whenever you're ready to subscribe.",
              ),
          ),
        );
        return;
      }
      case 'prospect-cold-invite': {
        const { to } = job.data as ProspectColdInviteData;
        const link = `${this.frontendUrl}/invited?email=${encodeURIComponent(to)}`;
        await this.send(
          to,
          "You've been invited to check out conference.contact",
          renderEmail(
            heading('Thought this might be useful') +
              paragraph(
                'A hand-verified directory of B2B conference contacts, with an AI tool that finds and enriches new leads live — take a look and see what’s inside.',
              ) +
              ctaButton(link, 'Take a look →') +
              footnote(
                'No obligation — you can create a free account just to browse.',
              ),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'admin-access-invite': {
        const { to, grantsDirectoryAccess, grantsLeadFinderAccess } =
          job.data as AdminAccessInviteData;
        const link = `${this.frontendUrl}/signup?email=${encodeURIComponent(to)}`;
        const perks: string[] = [];
        if (grantsDirectoryAccess === 'true') {
          perks.push('full access to the Lead Directory');
        }
        if (grantsLeadFinderAccess === 'true') {
          perks.push('unlimited AI Lead Finder searches');
        }
        const perksText =
          perks.length > 0
            ? `You've been given ${perks.join(' and ')} — no subscription needed. Create your account to get started.`
            : 'An account has been set up for you. Create your account to get started.';
        await this.send(
          to,
          "You've been invited to conference.contact",
          renderEmail(
            heading("You've been invited to conference.contact") +
              paragraph(perksText) +
              ctaButton(link, 'Create your account →') +
              footnote('Questions? Just reply to this email.'),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'prospect-pitch-intro': {
        const { to, fullName } = job.data as ProspectPitchData;
        const firstName = escapeHtml(
          fullName.trim().split(/\s+/)[0] || 'there',
        );
        const link = `${this.frontendUrl}/account/billing`;
        await this.send(
          to,
          'Still there? Your conference.contact directory is ready',
          renderEmail(
            heading(`${firstName}, here's what's waiting for you`) +
              paragraph(
                "You created a conference.contact account but haven't unlocked the full Lead Directory yet — a hand-verified list of who actually shows up to the B2B conference circuit, with real emails, phone numbers, and LinkedIn profiles.",
              ) +
              ctaButton(link, 'Unlock full access →') +
              footnote(
                '$50 every 6 months, rate locked in for as long as you stay subscribed. Cancel anytime.',
              ),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'prospect-pitch-value': {
        const { to, fullName } = job.data as ProspectPitchData;
        const firstName = escapeHtml(
          fullName.trim().split(/\s+/)[0] || 'there',
        );
        const link = `${this.frontendUrl}/account/billing`;
        const features = [
          'Unlimited directory searches',
          'Full contact details — email, phone, LinkedIn',
          'CSV export',
          'AI Lead Finder credits included',
        ];
        await this.send(
          to,
          'What you get with full Directory access',
          renderEmail(
            heading(`${firstName}, here's exactly what unlocks`) +
              `<ul style="margin:20px 0 0;padding:0;list-style:none;text-align:left;">
                 ${features
                   .map(
                     (item) =>
                       `<li style="margin-top:10px;padding-left:24px;position:relative;font-size:14px;color:#5b5f73;line-height:1.5;">
                          <span style="position:absolute;left:0;color:#0b1454;font-weight:700;">✓</span>${escapeHtml(item)}
                        </li>`,
                   )
                   .join('')}
               </ul>` +
              ctaButton(link, 'See full access →') +
              footnote(
                '$50 every 6 months. No sales calls, no tiers to compare.',
              ),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'prospect-pitch-urgency': {
        const { to, fullName } = job.data as ProspectPitchData;
        const firstName = escapeHtml(
          fullName.trim().split(/\s+/)[0] || 'there',
        );
        const link = `${this.frontendUrl}/account/billing`;
        await this.send(
          to,
          'Lock in your rate before it changes',
          renderEmail(
            heading(
              `${firstName}, your price locks in the moment you subscribe`,
            ) +
              paragraph(
                "conference.contact is still $50 every 6 months today. If we ever raise the price, everyone already subscribed keeps the rate they signed up at — so there's no upside to waiting, only downside if pricing changes later.",
              ) +
              ctaButton(link, 'Lock in $50/6mo →') +
              footnote('No long-term contract — cancel anytime.'),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'subscription-confirmed': {
        const { to, productLabel, amountCents, renewsAt } =
          job.data as SubscriptionConfirmedData;
        const dateLabel = new Date(renewsAt).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        });
        const amountLabel = `$${(amountCents / 100).toFixed(2).replace(/\.00$/, '')}`;
        const link = `${this.frontendUrl}/account/billing`;
        await this.send(
          to,
          `You're subscribed — ${productLabel} confirmed`,
          renderEmail(
            heading("You're all set") +
              paragraph(
                `Your payment went through and your ${escapeHtml(productLabel)} plan is active. You were charged ${amountLabel} — it renews on <strong>${dateLabel}</strong>.`,
              ) +
              ctaButton(link, 'Manage your plan →') +
              footnote(
                'Questions about your subscription? Just reply to this email.',
              ),
          ),
          this.supportEmail,
        );
        return;
      }
      case 'renewal-reminder': {
        const { to, productLabel, renewalDate, amountCents } =
          job.data as RenewalReminderData;
        const dateLabel = new Date(renewalDate).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        });
        const amountLabel = `$${(amountCents / 100).toFixed(2).replace(/\.00$/, '')}`;
        await this.send(
          to,
          `Your ${productLabel} renews in 7 days — conference.contact`,
          renderEmail(
            heading('Your subscription renews soon') +
              paragraph(
                `Your ${escapeHtml(productLabel)} plan renews on <strong>${dateLabel}</strong> — you'll be charged ${amountLabel}.`,
              ) +
              footnote(
                "No action needed to continue. Want to stop future billing instead? You can cancel anytime from your account — access stays active through the end of the period you've already paid for.",
              ),
          ),
        );
        return;
      }
      case 'payment-failed': {
        const { to, productLabel, gracePeriodDays } =
          job.data as PaymentFailedData;
        const link = `${this.frontendUrl}/account/billing`;
        await this.send(
          to,
          `Payment failed on your ${productLabel} plan — conference.contact`,
          renderEmail(
            heading('We couldn’t process your payment') +
              paragraph(
                `Your card was declined for your ${escapeHtml(productLabel)} plan. You have <strong>${gracePeriodDays} days</strong> to update your payment method before access pauses.`,
              ) +
              ctaButton(link, 'Update payment method →') +
              footnote(
                "We'll retry the charge automatically in the meantime — if it goes through, there's nothing else to do.",
              ),
          ),
        );
        return;
      }
      case 'cancellation-scheduled': {
        const { to, productLabel, accessUntil } =
          job.data as CancellationScheduledData;
        const dateLabel = new Date(accessUntil).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        });
        const link = `${this.frontendUrl}/account/billing`;
        await this.send(
          to,
          `Your ${productLabel} plan is set to cancel — conference.contact`,
          renderEmail(
            heading('Your cancellation is scheduled') +
              paragraph(
                `We've turned off future billing for your ${escapeHtml(productLabel)} plan. Your access stays active through <strong>${dateLabel}</strong> — you won't be charged again after that.`,
              ) +
              ctaButton(link, 'Manage your plan →') +
              footnote(
                'Changed your mind? You can resume anytime before that date and keep your access uninterrupted.',
              ),
          ),
          this.supportEmail,
        );
        return;
      }
      default:
        this.logger.warn(`Unknown email job name: ${job.name}`);
    }
  }

  /**
   * Throws on a Resend error, unlike the old inline version — that one
   * swallowed the error deliberately so a flaky Resend call could never
   * fail the HTTP request that triggered it. Now that sending happens off
   * the request entirely, BullMQ's retry/backoff (QueueModule) is what
   * should absorb a transient failure, and a throw is what lets it retry.
   */
  private async send(
    to: string,
    subject: string,
    html: string,
    replyTo?: string,
  ): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
      ...(replyTo && { replyTo }),
    });
    if (error) {
      throw new Error(
        `Resend error sending "${subject}" to ${to}: ${error.message}`,
      );
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(
      `Email job ${job.id} (${job.name}) failed after ${job.attemptsMade} attempt(s): ${err.message}`,
    );
  }
}
