import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Resend } from 'resend';
import { BULK_EMAIL_QUEUE } from '../queue/queue.module';
import {
  ctaButton,
  escapeHtml,
  footnote,
  heading,
  paragraph,
  renderEmail,
} from './email-template.util';
import { signUnsubscribeToken } from './unsubscribe-token.util';

interface ProspectColdInviteData {
  to: string;
}

/**
 * Separate worker from EmailProcessor, on its own queue (BULK_EMAIL_QUEUE)
 * and rate-limited below — a 30,000-email cold-outreach campaign must never
 * sit in front of a password-reset or login-code job in the same worker.
 * Every send here carries a real unsubscribe link (see
 * unsubscribe-token.util) since, unlike every other email in this app,
 * these go to people who never asked to hear from us.
 */
@Processor(BULK_EMAIL_QUEUE, {
  limiter: { max: 10, duration: 1_000 },
})
export class BulkEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(BulkEmailProcessor.name);
  private readonly resend: Resend;
  private readonly from: string;
  private readonly frontendUrl: string;
  private readonly supportEmail: string;
  private readonly unsubscribeSecret: string;
  private readonly mailingAddress: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.resend = new Resend(this.config.getOrThrow<string>('RESEND_API_KEY'));
    this.from = this.config.getOrThrow<string>('RESEND_FROM_EMAIL');
    this.frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    this.supportEmail = this.config.getOrThrow<string>('SUPPORT_EMAIL');
    this.unsubscribeSecret =
      this.config.getOrThrow<string>('UNSUBSCRIBE_SECRET');
    this.mailingAddress = this.config.getOrThrow<string>(
      'COMPANY_MAILING_ADDRESS',
    );
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'prospect-cold-invite': {
        const { to } = job.data as ProspectColdInviteData;
        const link = `${this.frontendUrl}/invited?email=${encodeURIComponent(to)}`;
        const unsubscribeLink = `${this.frontendUrl}/unsubscribe?email=${encodeURIComponent(to)}&token=${encodeURIComponent(signUnsubscribeToken(to, this.unsubscribeSecret))}`;
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
            // CAN-SPAM requires a visible opt-out link and a physical
            // mailing address in the body of any commercial email — a
            // List-Unsubscribe header alone (below) satisfies neither.
            `<p style="text-align:center;margin-top:12px;font-size:12px;color:#9395a6;">
               <a href="${unsubscribeLink}" style="color:#9395a6;text-decoration:underline;">Unsubscribe</a> from emails like this.
             </p>
             <p style="text-align:center;margin-top:8px;font-size:11px;color:#b3b5c2;">${escapeHtml(this.mailingAddress)}</p>`,
          ),
          this.supportEmail,
          unsubscribeLink,
        );
        return;
      }
      default:
        this.logger.warn(`Unknown bulk email job name: ${job.name}`);
    }
  }

  private async send(
    to: string,
    subject: string,
    html: string,
    replyTo: string,
    unsubscribeLink: string,
  ): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to,
      subject,
      html,
      replyTo,
      // RFC 8058 one-click unsubscribe header — what lets Gmail/Outlook
      // surface a native "Unsubscribe" affordance next to the sender,
      // independent of whether the recipient ever opens the email at all.
      headers: {
        'List-Unsubscribe': `<${unsubscribeLink}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
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
      `Bulk email job ${job.id} (${job.name}) failed after ${job.attemptsMade} attempt(s): ${err.message}`,
    );
  }
}
