import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type * as runtime from '@prisma/client/runtime/client';
import { Job } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { APOLLO_SEARCH_QUEUE } from '../queue/queue.module';
import { ApolloSearchFilters, ApolloService } from './apollo.service';
import { ApolloSearchJobData, LeadsService } from './leads.service';

/**
 * Worker side of Lead Finder's live search — runs off the request entirely
 * (LeadsService.aiSearch only creates the job row and enqueues) since a
 * real search-then-enrich run against Apollo is one HTTP round trip per
 * candidate, each spending a real credit, and can take several seconds.
 *
 * Filters arrive pre-parsed in job.data — Claude only ever runs once, in
 * LeadsService.parseQuery, to produce the review panel's first draft. By
 * the time a job reaches this processor the user has already confirmed
 * (and possibly edited) those filters, so re-calling Claude here would
 * silently discard their edits.
 *
 * Single attempt only (see LeadsModule's registerQueue override) — BullMQ's
 * default retry-on-failure would re-run an already-partially-completed
 * search, duplicating Apollo spend and result rows. A real failure here is
 * surfaced as job status FAILED, not retried.
 */
@Processor(APOLLO_SEARCH_QUEUE)
export class ApolloSearchProcessor extends WorkerHost {
  private readonly logger = new Logger(ApolloSearchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apollo: ApolloService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job<ApolloSearchJobData>): Promise<void> {
    const { jobId, userId, filters, cap, excludeApolloPersonIds } = job.data;

    try {
      if (filters.personName) {
        await this.processDirectMatch(jobId, userId, filters);
        return;
      }

      const excludeSet = new Set(excludeApolloPersonIds ?? []);
      // Over-fetch when excluding already-seen people so a "get more
      // leads" run still has a real shot at filling the cap with NEW
      // candidates — Apollo has no "exclude these ids" search param, so
      // this is done by requesting extra and filtering client-side rather
      // than a perfect pagination guarantee (bounded by Apollo's own
      // 100-per-page ceiling).
      const perPage = Math.min(cap + excludeSet.size, 100);
      const found = await this.apollo.searchPeople(filters, perPage);
      const candidates = found
        .filter((c) => !excludeSet.has(c.apolloPersonId))
        .slice(0, cap);

      if (candidates.length === 0) {
        await this.prisma.leadSearchJob.update({
          where: { id: jobId },
          data: { status: 'COMPLETED' },
        });
        return;
      }

      const pendingResults = await Promise.all(
        candidates.map((candidate) =>
          this.prisma.leadSearchResult.create({
            data: {
              jobId,
              apolloPersonId: candidate.apolloPersonId,
              name: candidate.name,
              title: candidate.title,
              company: candidate.company,
              status: 'pending',
            },
          }),
        ),
      );

      let enrichedCount = 0;
      for (const result of pendingResults) {
        // Checked between every enrichment call — each one spends a real
        // Apollo credit, so Cancel needs to actually stop new spend, not
        // just flip a flag the frontend happens to stop polling.
        const current = await this.prisma.leadSearchJob.findUnique({
          where: { id: jobId },
          select: { status: true },
        });
        if (current?.status === 'CANCELLED') {
          await this.prisma.leadSearchResult.updateMany({
            where: { jobId, status: 'pending' },
            data: { status: 'skipped' },
          });
          return;
        }

        // Reserved atomically BEFORE spending a real Apollo credit, not
        // decremented only on success afterward — two jobs racing on the
        // same user's balance (e.g. a fresh search and a concurrent "get
        // more leads") can't jointly overspend past zero this way, since
        // each reservation is a single guarded UPDATE.
        const reserved = await this.leads.tryReserveCredit(userId);
        if (!reserved) {
          await this.prisma.leadSearchResult.updateMany({
            where: { jobId, status: 'pending' },
            data: { status: 'skipped' },
          });
          break;
        }

        const enriched = await this.apollo.enrichPerson(result.apolloPersonId);
        if (enriched) {
          await this.prisma.leadSearchResult.update({
            where: { id: result.id },
            data: {
              name: enriched.name ?? result.name,
              title: enriched.title ?? result.title,
              company: enriched.company ?? result.company,
              linkedin: enriched.linkedin,
              email: enriched.email,
              status: 'enriched',
            },
          });
          enrichedCount += 1;
        } else {
          // Apollo found nothing — a real 0-credit outcome on their side
          // too, so give the reserved credit back.
          await this.leads.refundCredit(userId);
          await this.prisma.leadSearchResult.update({
            where: { id: result.id },
            data: { status: 'failed' },
          });
        }
      }

      await this.prisma.leadSearchJob.update({
        where: { id: jobId },
        data: { status: 'COMPLETED' },
      });

      await this.audit.record({
        actorUserId: userId,
        action: 'leads.ai_search',
        metadata: {
          jobId,
          filters,
          candidateCount: candidates.length,
          enrichedCount,
          more: excludeSet.size > 0,
        } as unknown as runtime.InputJsonValue,
      });
    } catch (err) {
      this.logger.error(
        `Apollo search job ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.prisma.leadSearchJob.update({
        where: { id: jobId },
        data: { status: 'FAILED' },
      });
    }
  }

  /**
   * The "find THIS exact person" path — one direct Apollo match call
   * instead of search-then-enrich-each-candidate. Still produces exactly
   * one LeadSearchResult row so the frontend's polling/rendering code
   * doesn't need to know which path a given job took.
   */
  private async processDirectMatch(
    jobId: string,
    userId: string,
    filters: ApolloSearchFilters,
  ): Promise<void> {
    const reserved = await this.leads.tryReserveCredit(userId);
    if (!reserved) {
      await this.prisma.leadSearchJob.update({
        where: { id: jobId },
        data: { status: 'COMPLETED' },
      });
      return;
    }

    const matched = await this.apollo.matchByName(
      filters.personName!,
      filters.personOrganization,
    );
    if (!matched) {
      await this.leads.refundCredit(userId);
    }

    const result = await this.prisma.leadSearchResult.create({
      data: {
        jobId,
        apolloPersonId: `name:${filters.personName}`,
        name: matched?.name ?? filters.personName!,
        title: matched?.title ?? null,
        company: matched?.company ?? filters.personOrganization ?? null,
        linkedin: matched?.linkedin ?? null,
        email: matched?.email ?? null,
        status: matched ? 'enriched' : 'failed',
      },
    });

    await this.prisma.leadSearchJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED' },
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'leads.ai_search',
      metadata: {
        jobId,
        filters,
        directMatch: true,
        resultId: result.id,
        enrichedCount: matched ? 1 : 0,
      } as unknown as runtime.InputJsonValue,
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ApolloSearchJobData>, err: Error): void {
    this.logger.error(
      `Apollo search job ${job.data.jobId} worker-level failure: ${err.message}`,
    );
  }
}
