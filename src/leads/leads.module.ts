import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { APOLLO_SEARCH_QUEUE } from '../queue/queue.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ApolloSearchProcessor } from './apollo-search.processor';
import { ApolloService } from './apollo.service';
import { ClaudeService } from './claude.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { PublicLeadsController } from './public-leads.controller';

@Module({
  // SubscriptionsModule is what actually exports DirectoryAccessGuard,
  // which LeadsController uses via @UseGuards(DirectoryAccessGuard) on the
  // Lead Directory routes — Nest needs it reachable in this module's
  // injector to construct one. The AI Lead Finder routes have no route
  // guard at all; they're gated purely by credit balance inside
  // LeadsService (see hasPaidLeadFinderTier).
  imports: [
    SubscriptionsModule,
    AuditModule,
    // defaultJobOptions here fully replaces (not merges with) QueueModule's
    // root default, so every field that matters is repeated explicitly.
    // attempts: 1 is the deliberate change — a retried Apollo search would
    // re-run an already-partially-completed job, duplicating real Apollo
    // spend. See ApolloSearchProcessor.
    BullModule.registerQueue({
      name: APOLLO_SEARCH_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    }),
  ],
  controllers: [LeadsController, PublicLeadsController],
  providers: [
    LeadsService,
    ClaudeService,
    ApolloService,
    ApolloSearchProcessor,
  ],
  exports: [LeadsService],
})
export class LeadsModule {}
