import { InjectQueue } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EmailModule } from '../email/email.module';
import { RENEWAL_REMINDER_QUEUE } from '../queue/queue.module';
import { RenewalReminderProcessor } from './renewal-reminder.processor';
import { RenewalReminderService } from './renewal-reminder.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: RENEWAL_REMINDER_QUEUE }),
    EmailModule,
  ],
  providers: [RenewalReminderService, RenewalReminderProcessor],
})
export class RenewalReminderModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(RenewalReminderModule.name);

  constructor(
    @InjectQueue(RENEWAL_REMINDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * `upsertJobScheduler` (BullMQ 6's replacement for `add(..., {repeat})`)
   * is keyed by the scheduler id given here — calling it again with the
   * same id and pattern on a later boot updates/no-ops instead of
   * registering a duplicate daily job. 9am UTC scan is deliberately not
   * midnight — a renewal email landing at 9am reads as a business notice;
   * one at midnight reads as spam-timed.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'daily-renewal-reminder-scan',
      { pattern: '0 9 * * *' },
      { name: 'scan' },
    );
    this.logger.log('Daily renewal reminder scan scheduled (09:00 UTC).');
  }
}
