import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { stringify } from 'csv-stringify/sync';
import type { Redis } from 'ioredis';
import { APOLLO_SEARCH_QUEUE, REDIS_CLIENT } from '../queue/queue.module';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { hasActiveAccess } from '../subscriptions/subscription-access.util';
import {
  COMPANY_SIZE_RANGES,
  DEPARTMENT_TAXONOMY,
  PERSON_SENIORITIES,
  REVENUE_BUCKETS,
} from './apollo-taxonomy';
import { ApolloService, ApolloSearchFilters } from './apollo.service';
import { ClaudeService, ParsedSearchFilters } from './claude.service';
import { UNCLASSIFIED, resolveCompanyTypeFilter } from './constants';
import { AiSearchDto } from './dto/ai-search.dto';
import { ExportLeadsQueryDto } from './dto/export-leads-query.dto';
import { GetMoreLeadsDto } from './dto/get-more-leads.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { ParseQueryDto } from './dto/parse-query.dto';
import { SelfSubmitLeadDto } from './dto/self-submit-lead.dto';
import { SuggestQueryDto } from './dto/suggest-query.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';

export interface ApolloSearchJobData {
  jobId: string;
  userId: string;
  filters: ApolloSearchFilters;
  /** Candidates enriched, capped by both remaining credits and LEAD_SEARCH_MAX_RESULTS — computed once here. */
  cap: number;
  /** Set only for a "get more leads" run on an already-completed job — Apollo person ids already in this job's results, so the processor doesn't re-spend a credit re-enriching someone already found. */
  excludeApolloPersonIds?: string[];
}

const LEAD_SELECT = {
  id: true,
  name: true,
  title: true,
  company: true,
  website: true,
  linkedin: true,
  appLink: true,
  email: true,
  phone: true,
  companyType: true,
  likelyToAttend: true,
} satisfies Prisma.LeadSelect;

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface LeadFilters {
  companyType?: string;
  likelyToAttend?: string;
  search?: string;
  hasEmail?: boolean;
}

const CSV_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'title', header: 'Title' },
  { key: 'company', header: 'Company' },
  { key: 'companyType', header: 'Type of Company' },
  { key: 'likelyToAttend', header: 'Likely to Attend' },
  { key: 'website', header: 'Website' },
  { key: 'linkedin', header: 'LinkedIn' },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
] as const;

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  private readonly maxResultsPerSearch: number;
  /** Accounts with no paid Lead Finder access (see hasPaidLeadFinderAccess) are capped to this many *new* searches per calendar day — "get more leads" on an existing search is blocked outright for them instead of counting separately. */
  private readonly freeTierMaxSearchesPerDay = 4;
  /** ...and each of those searches returns at most this many results, regardless of remaining credit balance. */
  private readonly freeTierMaxResultsPerSearch = 25;
  /** No-account visitors get the same daily allowance as a signed-up free-tier user, tracked per IP in Redis instead of per user row — see anonymousSearch. */
  private readonly anonymousMaxSearchesPerDay = 3;
  private readonly anonymousMaxResultsPerSearch = 3;
  private readonly gracePeriodDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly claude: ClaudeService,
    private readonly apollo: ApolloService,
    @InjectQueue(APOLLO_SEARCH_QUEUE)
    private readonly apolloQueue: Queue<ApolloSearchJobData>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.maxResultsPerSearch = this.config.get<number>(
      'LEAD_SEARCH_MAX_RESULTS',
      25,
    );
    // Same grace period as the Directory plan (PAYMENT_GRACE_PERIOD_DAYS) —
    // one payment-lifecycle policy across both products, not a
    // Lead-Finder-specific number to keep in sync separately.
    this.gracePeriodDays = this.config.get<number>(
      'PAYMENT_GRACE_PERIOD_DAYS',
      7,
    );
  }

  private startOfToday(): Date {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start;
  }

  private secondsUntilMidnight(): number {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    return Math.ceil((midnight.getTime() - Date.now()) / 1000);
  }

  /**
   * Redis-backed daily counter for the no-account AI Lead Finder demo,
   * keyed per IP instead of per user row (there's no user). This is the
   * *only* thing standing between an anonymous visitor and unlimited real
   * Apollo spend, so unlike TokenRevocationService's attempt-tracking (a
   * defense-in-depth layer that fails open) this fails closed: a Redis
   * outage blocks anonymous search entirely rather than silently removing
   * the one cost guard it has.
   */
  private async checkAnonymousSearchLimit(ip: string): Promise<{
    searchesUsedToday: number;
    searchesRemainingToday: number;
  }> {
    let count: number;
    try {
      const key = `anon-ai-search:${ip}`;
      count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, this.secondsUntilMidnight());
      }
    } catch {
      throw new ServiceUnavailableException(
        'The free search demo is temporarily unavailable — please try again in a moment, or sign up for full access.',
      );
    }

    if (count > this.anonymousMaxSearchesPerDay) {
      throw new ForbiddenException(
        `You've used your ${this.anonymousMaxSearchesPerDay} free searches today. Sign up to get up to 1,000 enriched leads every month, unlimited database searches, and full CSV export — or come back tomorrow for ${this.anonymousMaxSearchesPerDay} more free searches.`,
      );
    }

    return {
      searchesUsedToday: count,
      searchesRemainingToday: this.anonymousMaxSearchesPerDay - count,
    };
  }

  /**
   * A read-only "peek" at the same counter, for showing the "N free
   * searches remaining" banner before a visitor has searched at all —
   * deliberately doesn't INCR. Fails open (reports the full allowance) on
   * a Redis error, unlike checkAnonymousSearchLimit: this is informational
   * only, not the real spending gate.
   */
  async getAnonymousSearchStatus(
    ip: string,
  ): Promise<{ maxSearchesPerDay: number; searchesRemainingToday: number }> {
    try {
      const raw = await this.redis.get(`anon-ai-search:${ip}`);
      const count = raw ? parseInt(raw, 10) : 0;
      return {
        maxSearchesPerDay: this.anonymousMaxSearchesPerDay,
        searchesRemainingToday: Math.max(
          0,
          this.anonymousMaxSearchesPerDay - count,
        ),
      };
    } catch {
      return {
        maxSearchesPerDay: this.anonymousMaxSearchesPerDay,
        searchesRemainingToday: this.anonymousMaxSearchesPerDay,
      };
    }
  }

  /** Staff accounts (ADMIN/SUPER_ADMIN) run their own real searches to test and support the product — they're exempt from every Lead Finder limit below, not just the free-tier caps. */
  private async isAdminAccount(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  }

  /**
   * "Paid" bypasses the free-tier per-search/per-day caps below — it means
   * either an ACTIVE/TRIALING LeadFinderSubscription (a PAST_DUE one still
   * inside its grace period counts too, same policy as the Directory
   * plan's hasActiveAccess so a failed charge doesn't grant a free pass
   * forever), OR having ever bought a one-time credit pack. Without the
   * latter, someone who paid for 500+ credits would still be throttled to
   * 3 results/day like they'd never paid anything — the whole point of a
   * credit pack is spending it faster than that. Admin accounts count as
   * paid here too, per isAdminAccount above.
   */
  private async hasPaidLeadFinderAccess(userId: string): Promise<boolean> {
    if (await this.isAdminAccount(userId)) return true;
    const [subscription, creditPurchase] = await Promise.all([
      this.prisma.leadFinderSubscription.findFirst({
        where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
        select: { status: true, pastDueSince: true },
      }),
      this.prisma.creditGrant.findFirst({
        where: { userId, source: 'CREDIT_PACK_PURCHASE' },
        select: { id: true },
      }),
    ]);
    if (creditPurchase) return true;
    if (!subscription) return false;
    return hasActiveAccess(subscription, this.gracePeriodDays);
  }

  /**
   * Free-tier accounts (no paid Lead Finder plan) are rate-limited
   * independently of their credit balance — 3 new searches per calendar
   * day, 3 results each. Paid-tier accounts are unaffected: they're gated
   * purely by credits, same as before this existed.
   */
  async getFreeTierStatus(userId: string): Promise<{
    isPaidTier: boolean;
    maxResultsPerSearch: number;
    searchesUsedToday: number;
    maxSearchesPerDay: number;
    searchesRemainingToday: number | null;
  }> {
    const isPaidTier = await this.hasPaidLeadFinderAccess(userId);
    if (isPaidTier) {
      return {
        isPaidTier: true,
        maxResultsPerSearch: this.maxResultsPerSearch,
        searchesUsedToday: 0,
        maxSearchesPerDay: this.freeTierMaxSearchesPerDay,
        searchesRemainingToday: null,
      };
    }

    const searchesUsedToday = await this.prisma.leadSearchJob.count({
      where: { userId, createdAt: { gte: this.startOfToday() } },
    });
    return {
      isPaidTier: false,
      maxResultsPerSearch: this.freeTierMaxResultsPerSearch,
      searchesUsedToday,
      maxSearchesPerDay: this.freeTierMaxSearchesPerDay,
      searchesRemainingToday: Math.max(
        0,
        this.freeTierMaxSearchesPerDay - searchesUsedToday,
      ),
    };
  }

  /**
   * Shared by list/export/AI-search so the three can never quietly disagree
   * on what a given filter set matches. `approved: true` is always implicit
   * here — it's what keeps an unreviewed self-submission (see submitSelf)
   * out of every subscriber-facing surface until an admin reviews it. Admin
   * CRUD deliberately does NOT go through this method, since an admin needs
   * to see unapproved rows to review them.
   */
  buildWhere(filters: LeadFilters): Prisma.LeadWhereInput {
    return {
      approved: true,
      companyType: resolveCompanyTypeFilter(filters.companyType),
      likelyToAttend: filters.likelyToAttend,
      ...(filters.hasEmail && { email: { not: null } }),
      ...(filters.search && {
        OR: [
          { name: { contains: filters.search, mode: 'insensitive' } },
          { company: { contains: filters.search, mode: 'insensitive' } },
          { title: { contains: filters.search, mode: 'insensitive' } },
          { email: { contains: filters.search, mode: 'insensitive' } },
          { likelyToAttend: { contains: filters.search, mode: 'insensitive' } },
        ],
      }),
    };
  }

  async list(query: ListLeadsQueryDto): Promise<Page<unknown>> {
    const where = this.buildWhere(query);
    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        select: LEAD_SELECT,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.lead.count({ where }),
    ]);
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  async count(filters: LeadFilters): Promise<number> {
    return this.prisma.lead.count({ where: this.buildWhere(filters) });
  }

  async exportCsv(query: ExportLeadsQueryDto): Promise<string> {
    const leads = await this.prisma.lead.findMany({
      where: this.buildWhere(query),
      select: LEAD_SELECT,
      orderBy: { name: 'asc' },
    });

    return stringify(leads, {
      header: true,
      columns: CSV_COLUMNS as unknown as { key: string; header: string }[],
    });
  }

  /**
   * Unauthenticated homepage search preview — deliberately masked (no
   * email/phone/linkedin/website/appLink) and capped, so the real directory
   * can be teased without giving away the paid product for free.
   */
  async preview(search: string) {
    return this.prisma.lead.findMany({
      where: this.buildWhere({ search }),
      select: {
        name: true,
        title: true,
        company: true,
        companyType: true,
        likelyToAttend: true,
      },
      orderBy: { name: 'asc' },
      take: 5,
    });
  }

  /**
   * The public, no-account AI Lead Finder demo — same real Claude-parse +
   * Apollo-search-and-enrich pipeline the authenticated flow uses (via
   * ApolloSearchProcessor), just run synchronously and inline since it's
   * hard-capped to 3 results. No LeadSearchJob/LeadSearchResult rows are
   * created — there's no user to own them, and this is a one-shot preview,
   * not a saved search. Gated by checkAnonymousSearchLimit (per-IP, Redis)
   * rather than the controller's @Throttle — that gets us "N requests per
   * minute" for free, but the daily-reset, "X remaining" UX this needs is
   * easier to own directly than to reverse-engineer from Throttler headers.
   */
  async anonymousSearch(
    ip: string,
    query: string,
  ): Promise<{
    results: Array<{
      name: string | null;
      title: string | null;
      company: string | null;
      email: string | null;
      linkedin: string | null;
    }>;
    searchesRemainingToday: number;
  }> {
    const { searchesRemainingToday } = await this.checkAnonymousSearchLimit(ip);

    // Scoped to just the Claude/Apollo calls — checkAnonymousSearchLimit's
    // own exceptions (rate limit, Redis outage) must propagate untouched,
    // not get relabeled as a generic upstream failure.
    try {
      const parsed = await this.claude.parseApolloQuery(query);
      const filters = this.buildApolloFilters(parsed);

      if (filters.personName) {
        const enriched = await this.apollo.matchByName(
          filters.personName,
          filters.personOrganization,
        );
        return {
          results: enriched
            ? [
                {
                  name: enriched.name ?? filters.personName,
                  title: enriched.title,
                  company: enriched.company,
                  email: enriched.email,
                  linkedin: enriched.linkedin,
                },
              ]
            : [],
          searchesRemainingToday,
        };
      }

      const candidates = await this.apollo.searchPeople(
        filters,
        this.anonymousMaxResultsPerSearch,
      );
      const results: Array<{
        name: string | null;
        title: string | null;
        company: string | null;
        email: string | null;
        linkedin: string | null;
      }> = [];
      for (const candidate of candidates.slice(
        0,
        this.anonymousMaxResultsPerSearch,
      )) {
        const enriched = await this.apollo.enrichPerson(
          candidate.apolloPersonId,
        );
        if (enriched) {
          results.push({
            name: enriched.name ?? candidate.name,
            title: enriched.title ?? candidate.title,
            company: enriched.company ?? candidate.company,
            email: enriched.email,
            linkedin: enriched.linkedin,
          });
        }
      }
      return { results, searchesRemainingToday };
    } catch (err) {
      this.logger.warn(
        `Anonymous AI search failed for a parsed query: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'AI search is temporarily unavailable — please try again in a moment.',
      );
    }
  }

  /**
   * A signed-in user adding themselves to the directory — not gated by a
   * subscription (this is about being found, not about searching). Starts
   * unapproved so it never appears to a subscriber (buildWhere always
   * filters approved: true) until an admin reviews it via the existing
   * admin Lead CRUD, matching the "the six categories are hand-verified"
   * promise made everywhere else on the site.
   */
  async submitSelf(userId: string, dto: SelfSubmitLeadDto) {
    const lead = await this.prisma.lead.create({
      data: { ...dto, approved: false, submittedByUserId: userId },
      select: LEAD_SELECT,
    });
    await this.audit.record({
      actorUserId: userId,
      action: 'leads.self_submitted',
      targetType: 'Lead',
      targetId: lead.id,
    });
    return {
      message: "Submitted — we'll review it before it goes live.",
      lead,
    };
  }

  async getFilters() {
    const [companyTypes, events] = await Promise.all([
      this.prisma.lead.findMany({
        distinct: ['companyType'],
        select: { companyType: true },
        orderBy: { companyType: 'asc' },
      }),
      this.prisma.lead.findMany({
        distinct: ['likelyToAttend'],
        select: { likelyToAttend: true },
        orderBy: { likelyToAttend: 'asc' },
      }),
    ]);
    const realTypes = companyTypes
      .map((c) => c.companyType)
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const hasUnclassified = realTypes.length < companyTypes.length;

    return {
      // The UNCLASSIFIED sentinel only appears when at least one row
      // actually has no company type on file — no point offering a filter
      // that would always return zero rows.
      companyTypes: hasUnclassified
        ? [...realTypes, UNCLASSIFIED]
        : realTypes,
      events: events.map((e) => e.likelyToAttend),
    };
  }

  // ── Lead Finder (AI search) ─────────────────────────────────────────
  //
  // Access (does this user have an active subscription at all) is
  // SubscriptionGuard's job at the route level. Everything below is the
  // separate credit balance, which is a persistent per-User number, not
  // tied to a subscription or billing period at all — a lapsed subscriber
  // keeps whatever credits they had; a resubscribed one doesn't get more
  // just for that.

  async getCredits(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { leadFinderCredits: true },
    });
    const freeTier = await this.getFreeTierStatus(userId);
    return { credits: user.leadFinderCredits, ...freeTier };
  }

  /**
   * Atomically reserves one credit before spending a real Apollo credit —
   * `updateMany` with a `gt: 0` guard means this can't push the balance
   * negative even when two jobs (e.g. a fresh search and a concurrent "get
   * more leads" on another job) are decrementing at the same time. The
   * job's up-front `cap` (see aiSearch/getMoreLeads) is only an advisory
   * ceiling on how many candidates to fetch from Apollo — this is the
   * actual spending gate, checked fresh before every single enrichment
   * call instead of trusting a credit count read once when the job started.
   * Returns false once the balance hits 0, telling the caller to stop.
   */
  async tryReserveCredit(userId: string): Promise<boolean> {
    if (await this.isAdminAccount(userId)) return true;
    const result = await this.prisma.user.updateMany({
      where: { id: userId, leadFinderCredits: { gt: 0 } },
      data: { leadFinderCredits: { decrement: 1 } },
    });
    return result.count > 0;
  }

  /** Apollo enrichment that finds nothing is a real 0-credit outcome on Apollo's side too — give the reserved credit back. */
  async refundCredit(userId: string): Promise<void> {
    if (await this.isAdminAccount(userId)) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { leadFinderCredits: { increment: 1 } },
    });
  }

  /**
   * Preview step: turns a free-text query into the structured filter set
   * the review-parameters panel shows and lets the user edit. No job
   * created, no credits spent — the actual search only starts once the
   * user confirms (possibly edited) filters via aiSearch below.
   */
  async parseQuery(dto: ParseQueryDto): Promise<ParsedSearchFilters> {
    try {
      return await this.claude.parseApolloQuery(dto.query, dto.jobTitles);
    } catch (err) {
      this.logger.warn(`parseQuery failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'AI search is temporarily unavailable — please try again in a moment.',
      );
    }
  }

  /** Static reference data for the review-parameters panel — single source of truth shared with ApolloService's real-value validation, so the frontend never has to hand-duplicate (and risk drifting from) which values Apollo actually honors. */
  getTaxonomy() {
    return {
      personSeniorities: PERSON_SENIORITIES,
      companySizeRanges: COMPANY_SIZE_RANGES,
      revenueBuckets: REVENUE_BUCKETS,
      departments: DEPARTMENT_TAXONOMY,
    };
  }

  /**
   * Typeahead backed by real Lead Directory data — currently only wired up
   * to the review panel's "Search keywords" field (company names). "Target
   * roles" and "Target industries" use a static curated list client-side
   * instead (real, standard values not limited to our own ~21.7k-row
   * Directory) rather than this endpoint's "title" option, since Apollo
   * itself has no public autocomplete API to draw from (checked directly
   * against the live API — the only candidate endpoints either 404 or turn
   * out to be unrelated).
   */
  async suggest(dto: SuggestQueryDto): Promise<{ value: string }[]> {
    const pattern = `%${dto.q}%`;
    if (dto.field === 'title') {
      return this.prisma.$queryRaw<{ value: string }[]>`
        SELECT title AS value, COUNT(*) AS n
        FROM leads
        WHERE approved = true AND title ILIKE ${pattern}
        GROUP BY title
        ORDER BY n DESC
        LIMIT 8
      `;
    }
    return this.prisma.$queryRaw<{ value: string }[]>`
      SELECT company AS value, COUNT(*) AS n
      FROM leads
      WHERE approved = true AND company ILIKE ${pattern}
      GROUP BY company
      ORDER BY n DESC
      LIMIT 8
    `;
  }

  /** Maps the review-panel's field names onto Apollo's real filter shape — see apollo.service.ts for what's actually verified against the live API. */
  private buildApolloFilters(dto: {
    searchKeywords?: string[];
    targetIndustries?: string[];
    exclusions?: string[];
    personTitles?: string[];
    personSeniorities?: string[];
    personFunctions?: string[];
    location?: string;
    companySizeRanges?: string[];
    revenueMin?: number;
    revenueMax?: number;
    personName?: string;
    personOrganization?: string;
  }): ApolloSearchFilters {
    return {
      organizationKeywordTags: [
        ...(dto.searchKeywords ?? []),
        ...(dto.targetIndustries ?? []),
      ],
      excludeOrganizationKeywordTags: dto.exclusions,
      personTitles: dto.personTitles,
      personSeniorities: dto.personSeniorities,
      personFunctions: dto.personFunctions,
      organizationLocations: dto.location ? [dto.location] : undefined,
      organizationNumEmployeesRanges: dto.companySizeRanges,
      revenueMin: dto.revenueMin,
      revenueMax: dto.revenueMax,
      personName: dto.personName,
      personOrganization: dto.personOrganization,
    };
  }

  /**
   * Starts a live Apollo search: creates the job row and hands off to
   * ApolloSearchProcessor, which does the actual search-then-enrich work.
   * Returns immediately with a jobId to poll — a real run is several HTTP
   * calls to Apollo and doesn't belong on the request/response cycle. Runs
   * on exactly the filters passed in — no Claude call here, since the user
   * already reviewed (and could have edited) Claude's draft in the panel.
   */
  async aiSearch(userId: string, dto: AiSearchDto): Promise<{ jobId: string }> {
    const [user, isAdmin] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { leadFinderCredits: true },
      }),
      this.isAdminAccount(userId),
    ]);

    if (!isAdmin && user.leadFinderCredits <= 0) {
      throw new ForbiddenException(
        "You're out of Lead Finder credits. Buy more to keep searching.",
      );
    }

    const freeTier = await this.getFreeTierStatus(userId);
    if (!freeTier.isPaidTier && freeTier.searchesRemainingToday === 0) {
      throw new ForbiddenException(
        `You've used all ${freeTier.maxSearchesPerDay} free searches today (${freeTier.maxResultsPerSearch} results each). Upgrade for unlimited searches, or come back tomorrow for ${freeTier.maxSearchesPerDay} more free searches.`,
      );
    }

    const filters = this.buildApolloFilters(dto);

    const job = await this.prisma.leadSearchJob.create({
      data: {
        userId,
        query: dto.campaignName,
        jobTitles: dto.personTitles ?? [],
        filters: filters as unknown as Prisma.InputJsonValue,
        status: 'RUNNING',
      },
    });

    const cap = isAdmin
      ? freeTier.maxResultsPerSearch
      : Math.min(user.leadFinderCredits, freeTier.maxResultsPerSearch);
    await this.apolloQueue.add(
      'search',
      { jobId: job.id, userId, filters, cap },
      { attempts: 1 },
    );

    return { jobId: job.id };
  }

  /**
   * Extends an already-completed search with more candidates from the same
   * filters, skipping people already found. Reuses the same job row (flips
   * it back to RUNNING) so the frontend keeps polling the same jobId and
   * the new rows just append to the results it's already rendering.
   */
  async getMoreLeads(
    userId: string,
    jobId: string,
    dto: GetMoreLeadsDto,
  ): Promise<{ enqueued: boolean }> {
    const job = await this.prisma.leadSearchJob.findUnique({
      where: { id: jobId },
      include: { results: { select: { apolloPersonId: true } } },
    });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Search not found');
    }
    if (job.status === 'RUNNING') {
      throw new ForbiddenException('This search is still running.');
    }
    if (!job.filters) {
      throw new ForbiddenException(
        'This search predates structured filters and cannot be extended — start a new search.',
      );
    }

    const hasPaidAccess = await this.hasPaidLeadFinderAccess(userId);
    if (!hasPaidAccess) {
      throw new ForbiddenException(
        'Buy a credit pack or upgrade to a paid plan to get more leads per search — the free plan is capped at 3 results per search.',
      );
    }

    const [user, isAdmin] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { leadFinderCredits: true },
      }),
      this.isAdminAccount(userId),
    ]);
    if (!isAdmin && user.leadFinderCredits <= 0) {
      throw new ForbiddenException(
        "You're out of Lead Finder credits. Buy more to keep searching.",
      );
    }

    const requested = dto.count ?? this.maxResultsPerSearch;
    const cap = isAdmin
      ? Math.min(requested, this.maxResultsPerSearch)
      : Math.min(requested, user.leadFinderCredits, this.maxResultsPerSearch);

    await this.prisma.leadSearchJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING' },
    });

    await this.apolloQueue.add(
      'search',
      {
        jobId,
        userId,
        filters: job.filters as unknown as ApolloSearchFilters,
        cap,
        excludeApolloPersonIds: job.results.map((r) => r.apolloPersonId),
      },
      { attempts: 1 },
    );

    return { enqueued: true };
  }

  async getSearchJob(userId: string, jobId: string) {
    const job = await this.prisma.leadSearchJob.findUnique({
      where: { id: jobId },
      include: { results: { orderBy: { createdAt: 'asc' } } },
    });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Search not found');
    }
    return job;
  }

  /**
   * Idempotent — cancelling an already-terminal job is a no-op, not an
   * error, since the frontend's Stop button and the polling loop finishing
   * naturally can race harmlessly.
   */
  async cancelSearchJob(userId: string, jobId: string) {
    const job = await this.prisma.leadSearchJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Search not found');
    }
    if (job.status !== 'RUNNING') {
      return job;
    }
    return this.prisma.leadSearchJob.update({
      where: { id: jobId },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * The user's own triage of one enriched lead — approve or skip, or reset
   * back to "new". Purely a manual decision layered on top of the
   * enrichment pipeline's own `status`; doesn't touch credits, Apollo, or
   * the job's lifecycle at all.
   */
  async updateResultReviewStatus(
    userId: string,
    jobId: string,
    resultId: string,
    dto: UpdateReviewStatusDto,
  ) {
    const job = await this.prisma.leadSearchJob.findUnique({
      where: { id: jobId },
      select: { userId: true },
    });
    if (!job || job.userId !== userId) {
      throw new NotFoundException('Search not found');
    }

    const result = await this.prisma.leadSearchResult.findUnique({
      where: { id: resultId },
      select: { jobId: true },
    });
    if (!result || result.jobId !== jobId) {
      throw new NotFoundException('Lead not found');
    }

    return this.prisma.leadSearchResult.update({
      where: { id: resultId },
      data: { reviewStatus: dto.reviewStatus },
    });
  }

  async listSearchHistory(userId: string) {
    const jobs = await this.prisma.leadSearchJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { _count: { select: { results: true } } },
    });
    return jobs.map((job) => ({
      id: job.id,
      query: job.query,
      jobTitles: job.jobTitles,
      status: job.status,
      resultCount: job._count.results,
      createdAt: job.createdAt,
    }));
  }
}
