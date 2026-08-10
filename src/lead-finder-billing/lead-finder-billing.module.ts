import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { UsersModule } from '../users/users.module';
import { LeadFinderBillingController } from './lead-finder-billing.controller';
import { LeadFinderBillingService } from './lead-finder-billing.service';

@Module({
  imports: [BillingModule, UsersModule, AuditModule, EmailModule],
  controllers: [LeadFinderBillingController],
  providers: [LeadFinderBillingService],
  exports: [LeadFinderBillingService],
})
export class LeadFinderBillingModule {}
