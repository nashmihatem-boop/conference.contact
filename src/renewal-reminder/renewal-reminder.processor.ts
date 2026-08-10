import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RENEWAL_REMINDER_QUEUE } from '../queue/queue.module';
import { RenewalReminderService } from './renewal-reminder.service';

@Processor(RENEWAL_REMINDER_QUEUE)
export class RenewalReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(RenewalReminderProcessor.name);

  constructor(private readonly renewalReminder: RenewalReminderService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'scan') {
      this.logger.warn(`Unknown renewal-reminder job name: ${job.name}`);
      return;
    }
    await this.renewalReminder.sendDueReminders();
  }
}
