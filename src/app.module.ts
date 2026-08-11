import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { envValidationSchema } from './config/env.validation';
import { ContactModule } from './contact/contact.module';
import { EmailModule } from './email/email.module';
import { InvitesModule } from './invites/invites.module';
import { LeadsModule } from './leads/leads.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProspectCampaignModule } from './prospect-campaign/prospect-campaign.module';
import { QueueModule } from './queue/queue.module';
import { RenewalReminderModule } from './renewal-reminder/renewal-reminder.module';
import { SessionsModule } from './sessions/sessions.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      // Fail fast: an invalid/missing var throws at boot, not at first use.
      validationOptions: { abortEarly: false },
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        // Generous global default; sensitive endpoints (login, register,
        // password reset) override this with a tighter @Throttle() limit.
        { name: 'default', ttl: 60_000, limit: 100 },
      ],
    }),
    PrismaModule,
    QueueModule,
    CommonModule,
    UsersModule,
    SessionsModule,
    EmailModule,
    AuditModule,
    AuthModule,
    BillingModule,
    SubscriptionsModule,
    AdminModule,
    LeadsModule,
    ContactModule,
    InvitesModule,
    RenewalReminderModule,
    ProspectCampaignModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
