import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BULK_EMAIL_QUEUE, EMAIL_QUEUE } from '../queue/queue.module';
import { BulkEmailProcessor } from './bulk-email.processor';
import { EmailProcessor } from './email.processor';
import { EmailService } from './email.service';
import { UnsubscribeController } from './unsubscribe.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: EMAIL_QUEUE }, { name: BULK_EMAIL_QUEUE }),
  ],
  controllers: [UnsubscribeController],
  providers: [EmailService, EmailProcessor, BulkEmailProcessor],
  exports: [EmailService],
})
export class EmailModule {}
