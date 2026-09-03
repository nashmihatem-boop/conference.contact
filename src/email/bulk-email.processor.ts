import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service';
import { BULK_EMAIL_QUEUE } from '../queue/queue.module';
import {
  ctaButton,
  escapeHtml,
  footnote,
  heading,
  paragraph,
  renderEmail,
  sanitizeForSubject,
} from './email-template.util';
import {
  DEFAULT_BODY,
  DEFAULT_CTA_LABEL,
  DEFAULT_FOOTNOTE,
  DEFAULT_HEADING,
  DEFAULT_SUBJECT,
} from './prospect-invite-template-defaults';
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
  // Fallback only — an admin-saved emailMailingAddress on the campaign
  // settings row (see below) takes priority once one exists.
  private readonly defaultMailingAddress: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super();
    this.resend = new Resend(this.config.getOrThrow<string>('RESEND_API_KEY'));
    this.from = this.config.getOrThrow<string>('RESEND_FROM_EMAIL');
    this.frontendUrl = this.config.getOrThrow<string>('FRONTEND_URL');
    this.supportEmail = this.config.getOrThrow<string>('SUPPORT_EMAIL');
    this.unsubscribeSecret =
      this.config.getOrThrow<string>('UNSUBSCRIBE_SECRET');
    this.defaultMailingAddress = this.config.getOrThrow<string>(
      'COMPANY_MAILING_ADDRESS',
    );
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'prospect-cold-invite': {
        const { to } = job.data as ProspectColdInviteData;
        const link = `${this.frontendUrl}/invited?email=${encodeURIComponent(to)}`;
        const unsubscribeLink = `${this.frontendUrl}/unsubscribe?email=${encodeURIComponent(to)}&token=${encodeURIComponent(signUnsubscribeToken(to, this.unsubscribeSecret))}`;
        const settings =
          await this.prisma.prospectInviteCampaignSettings.findUnique({
            where: { id: 'singleton' },
            select: {
              emailSubject: true,
              emailHeading: true,
              emailBody: true,
              emailCtaLabel: true,
              emailFootnote: true,
              emailMailingAddress: true,
            },
          });
        await this.send(
          to,
          sanitizeForSubject(settings?.emailSubject ?? DEFAULT_SUBJECT),
          renderEmail(
            heading(escapeHtml(settings?.emailHeading ?? DEFAULT_HEADING)) +
              paragraph(escapeHtml(settings?.emailBody ?? DEFAULT_BODY)) +
              ctaButton(
                link,
                escapeHtml(settings?.emailCtaLabel ?? DEFAULT_CTA_LABEL),
              ) +
              footnote(escapeHtml(settings?.emailFootnote ?? DEFAULT_FOOTNOTE)),
            // CAN-SPAM requires a visible opt-out link and a physical
            // mailing address in the body of any commercial email — a
            // List-Unsubscribe header alone (below) satisfies neither.
            `<p style="text-align:center;margin-top:12px;font-size:12px;color:#9395a6;">
               <a href="${unsubscribeLink}" style="color:#9395a6;text-decoration:underline;">Unsubscribe</a> from emails like this.
             </p>
             <p style="text-align:center;margin-top:8px;font-size:11px;color:#b3b5c2;">${escapeHtml(settings?.emailMailingAddress ?? this.defaultMailingAddress)}</p>`,
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
