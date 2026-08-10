import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { StripeCustomerService } from './stripe-customer.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [UsersModule],
  providers: [StripeService, StripeCustomerService],
  exports: [StripeService, StripeCustomerService],
})
export class BillingModule {}
