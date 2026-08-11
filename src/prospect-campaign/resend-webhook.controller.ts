import {
  BadRequestException,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { verifyResendWebhookSignature } from '../email/resend-webhook.util';
import { ProspectCampaignService } from './prospect-campaign.service';

interface ResendWebhookEvent {
  type: string;
  data?: { to?: string[] };
}

/**
 * Resend authenticates this via Svix signature headers, not a bearer
 * token — hence @Public(). Needs the raw request body to verify the
 * signature, same reasoning as WebhooksController's Stripe handler — see
 * main.ts's express.raw() scoping for this exact path.
 *
 * Only `email.bounced` and `email.complained` matter here: both mean
 * "never contact this address again" (see ProspectCampaignService), which
 * is exactly what feeds the campaign's bounce/complaint circuit breaker.
 * Everything else (sent/delivered/opened/clicked) is a 200 no-op.
 */
@ApiExcludeController()
@Controller('webhooks')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);
  private readonly webhookSecret?: string;

  constructor(
    config: ConfigService,
    private readonly campaign: ProspectCampaignService,
  ) {
    this.webhookSecret = config.get<string>('RESEND_WEBHOOK_SECRET');
  }

  @Public()
  @Post('resend')
  async handleResendWebhook(
    @Req() req: Request,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ): Promise<{ received: true }> {
    if (!this.webhookSecret) {
      this.logger.warn(
        'Resend webhook received but RESEND_WEBHOOK_SECRET is not configured.',
      );
      throw new ServiceUnavailableException('Webhook not configured');
    }

    const rawBody = (req.body as Buffer).toString('utf8');
    const valid = verifyResendWebhookSignature(
      rawBody,
      { svixId, svixTimestamp, svixSignature },
      this.webhookSecret,
    );
    if (!valid) {
      this.logger.warn('Resend webhook signature verification failed.');
      throw new BadRequestException('Webhook signature verification failed');
    }

    let event: ResendWebhookEvent;
    try {
      event = JSON.parse(rawBody) as ResendWebhookEvent;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    const recipient = event.data?.to?.[0];
    if (recipient) {
      if (event.type === 'email.bounced') {
        await this.campaign.markBounced(recipient);
      } else if (event.type === 'email.complained') {
        await this.campaign.markComplained(recipient);
      }
    }

    return { received: true };
  }
}
