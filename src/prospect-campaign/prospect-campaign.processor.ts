import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PROSPECT_CAMPAIGN_QUEUE } from '../queue/queue.module';
import { ProspectCampaignService } from './prospect-campaign.service';

@Processor(PROSPECT_CAMPAIGN_QUEUE)
export class ProspectCampaignProcessor extends WorkerHost {
  private readonly logger = new Logger(ProspectCampaignProcessor.name);

  constructor(private readonly campaign: ProspectCampaignService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'drip') {
      this.logger.warn(`Unknown prospect-campaign job name: ${job.name}`);
      return;
    }
    await this.campaign.runDailyDrip();
  }
}
