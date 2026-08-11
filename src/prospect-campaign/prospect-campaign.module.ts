import { InjectQueue } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Module, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { PROSPECT_CAMPAIGN_QUEUE } from '../queue/queue.module';
import { ProspectCampaignProcessor } from './prospect-campaign.processor';
import { ProspectCampaignService } from './prospect-campaign.service';
import { ResendWebhookController } from './resend-webhook.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: PROSPECT_CAMPAIGN_QUEUE }),
    EmailModule,
    AuditModule,
  ],
  controllers: [ResendWebhookController],
  providers: [ProspectCampaignService, ProspectCampaignProcessor],
  exports: [ProspectCampaignService],
})
export class ProspectCampaignModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProspectCampaignModule.name);

  constructor(
    @InjectQueue(PROSPECT_CAMPAIGN_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * 10am UTC, same reasoning as RenewalReminderModule's 9am scan — a
   * cold-outreach batch landing mid-morning reads as a business send, not
   * spam-timed. upsertJobScheduler is idempotent across restarts (keyed by
   * the scheduler id given here).
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'daily-prospect-campaign-drip',
      { pattern: '0 10 * * *' },
      { name: 'drip' },
    );
    this.logger.log('Daily prospect campaign drip scheduled (10:00 UTC).');
  }
}
