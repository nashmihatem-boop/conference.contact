import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { TokenRevocationService } from '../common/token-revocation/token-revocation.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  daysPastDue,
  hasActiveAccess,
} from '../subscriptions/subscription-access.util';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { ListFlaggedSessionsQueryDto } from './dto/list-flagged-sessions-query.dto';
import { ListSubscriptionsQueryDto } from './dto/list-subscriptions-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { CreateLeadDto } from '../leads/dto/create-lead.dto';
import { ListLeadsQueryDto } from '../leads/dto/list-leads-query.dto';
import { UpdateLeadDto } from '../leads/dto/update-lead.dto';
import { ListContactMessagesQueryDto } from '../contact/dto/list-contact-messages-query.dto';
import { ReplyContactMessageDto } from '../contact/dto/reply-contact-message.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { SetDirectoryAccessDto } from './dto/set-directory-access.dto';
import { ListProspectsQueryDto } from './dto/list-prospects-query.dto';
import { PitchProspectDto } from './dto/pitch-prospect.dto';

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
  approved: true,
  submittedBy: { select: { id: true, email: true, fullName: true } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LeadSelect;

const SESSION_SECURITY_SELECT = {
  id: true,
  ipAddress: true,
  country: true,
  city: true,
  timezone: true,
  riskScore: true,
  riskSignals: true,
  createdAt: true,
  lastActivityAt: true,
  revokedAt: true,
  device: {
    select: {
      id: true,
      browserName: true,
      os: true,
      deviceType: true,
      isTrusted: true,
    },
  },
} satisfies Prisma.SessionSelect;

const USER_LIST_SELECT = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  role: true,
  status: true,
  stripeCustomerId: true,
  emailVerifiedAt: true,
  twoFactorEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  leadFinderCredits: true,
  adminGrantedDirectoryAccess: true,
} satisfies Prisma.UserSelect;

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

@Injectable()
export class AdminService {
  private readonly gracePeriodDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly revocation: TokenRevocationService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    private readonly email: EmailService,
  ) {
    this.gracePeriodDays = this.config.get<number>(
      'PAYMENT_GRACE_PERIOD_DAYS',
      7,
    );
  }

  // ── Users ────────────────────────────────────────────────────────────

  async listUsers(query: ListUsersQueryDto): Promise<Page<unknown>> {
    // Deleted accounts stay out of the default view — real data, but not
    // something that should clutter the list every admin loading this page
    // has to scroll past. Explicitly filtering by "Deleted" (or any other
    // status) still finds them; only the unfiltered default excludes them.
    const where: Prisma.UserWhereInput = {
      status: query.status ?? { not: 'DELETED' },
      role: query.role,
      ...(query.search && {
        OR: [
          { email: { contains: query.search, mode: 'insensitive' } },
          { fullName: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    const enriched = await this.attachBillingSummary(data);
    return {
      data: enriched,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * "Purchased" and "lifetime paid" for a page of users — real numbers,
   * not estimates. Purchased = sum of CreditGrant.credits (logged at the
   * moment of every real credit-pack purchase and Lead Finder tier invoice
   * going forward — see subscriptions.service.ts and
   * lead-finder-billing.service.ts). Lifetime paid = that same ledger's
   * amountPaidCents plus every paid Directory-subscription Invoice (a
   * separate, pre-existing real ledger). Grants from before CreditGrant
   * existed aren't backfilled — there was no local record of them to
   * backfill from — so an older account's "purchased" figure only reflects
   * activity from when this shipped onward.
   */
  private async attachBillingSummary<T extends { id: string }>(
    users: T[],
  ): Promise<(T & { creditsPurchased: number; lifetimePaidCents: number })[]> {
    const userIds = users.map((u) => u.id);
    if (userIds.length === 0) return [];

    const [creditGrantSums, subscriptionsWithInvoices] = await Promise.all([
      this.prisma.creditGrant.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _sum: { credits: true, amountPaidCents: true },
      }),
      this.prisma.subscription.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          invoices: {
            where: { status: 'PAID' },
            select: { amountCents: true },
          },
        },
      }),
    ]);

    const creditsPurchasedByUser = new Map(
      creditGrantSums.map((g) => [g.userId, g._sum.credits ?? 0]),
    );
    const creditPaidCentsByUser = new Map(
      creditGrantSums.map((g) => [g.userId, g._sum.amountPaidCents ?? 0]),
    );
    const directoryPaidCentsByUser = new Map<string, number>();
    for (const sub of subscriptionsWithInvoices) {
      const sum = sub.invoices.reduce((acc, inv) => acc + inv.amountCents, 0);
      directoryPaidCentsByUser.set(
        sub.userId,
        (directoryPaidCentsByUser.get(sub.userId) ?? 0) + sum,
      );
    }

    return users.map((user) => ({
      ...user,
      creditsPurchased: creditsPurchasedByUser.get(user.id) ?? 0,
      lifetimePaidCents:
        (creditPaidCentsByUser.get(user.id) ?? 0) +
        (directoryPaidCentsByUser.get(user.id) ?? 0),
    }));
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: USER_LIST_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');

    const [deviceCount, activeSessionCount, subscription] = await Promise.all([
      this.prisma.device.count({ where: { userId: id } }),
      this.prisma.session.count({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.prisma.subscription.findFirst({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          status: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          plan: { select: { name: true } },
        },
      }),
    ]);

    return { ...user, deviceCount, activeSessionCount, subscription };
  }

  async getUserSessions(userId: string) {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');

    return this.prisma.session.findMany({
      where: { userId },
      select: SESSION_SECURITY_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async suspendUser(
    adminUserId: string,
    targetUserId: string,
    reason: string | undefined,
  ): Promise<{ message: string }> {
    if (adminUserId === targetUserId) {
      throw new ForbiddenException('You cannot suspend your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot suspend an account with status ${target.status}`,
      );
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: 'SUSPENDED' },
    });
    await this.sessions.revokeAllForUser(targetUserId);
    // Refresh tokens are now revoked (blocks login/refresh), but a bearer
    // access token issued moments ago is still cryptographically valid on
    // its own — this is what makes JwtAuthGuard reject it immediately too,
    // instead of leaving it usable for up to its remaining 15-minute TTL.
    await this.revocation.revokeUser(targetUserId);

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.user_suspended',
      targetType: 'User',
      targetId: targetUserId,
      metadata: reason ? { reason } : undefined,
    });

    return { message: 'User suspended' };
  }

  async reactivateUser(
    adminUserId: string,
    targetUserId: string,
  ): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.status !== 'SUSPENDED') {
      throw new BadRequestException(
        `Cannot reactivate an account with status ${target.status}`,
      );
    }

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: 'ACTIVE' },
    });

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.user_reactivated',
      targetType: 'User',
      targetId: targetUserId,
    });

    return { message: 'User reactivated' };
  }

  /**
   * Reuses the real user-facing forgot-password flow — same token, same
   * email, same expiry — rather than a separate admin-only path, so there's
   * exactly one way a password reset link ever gets issued. There is no
   * way to view or recover a user's actual password (it's stored as an
   * argon2 hash, never in reversible form) — this is the only legitimate
   * admin-side lever for "this user can't get in."
   */
  async sendPasswordReset(
    adminUserId: string,
    targetUserId: string,
  ): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { email: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.authService.forgotPassword({ email: target.email });

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.password_reset_sent',
      targetType: 'User',
      targetId: targetUserId,
    });

    return { message: `Password reset link sent to ${target.email}.` };
  }

  /**
   * Soft delete: status becomes DELETED, never a hard row removal — billing
   * and audit history must survive (Subscription→User is onDelete: Restrict
   * specifically to make hard-deleting a user with billing history
   * impossible). This is what "remove this person's account" means when an
   * admin asks for it, as distinct from suspend (routine, reversible) or
   * the user's own self-service GDPR deletion (DELETE /auth/account).
   */
  async deleteUser(
    adminUserId: string,
    targetUserId: string,
  ): Promise<{ message: string }> {
    if (adminUserId === targetUserId) {
      throw new ForbiddenException('You cannot delete your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.status === 'DELETED') {
      throw new BadRequestException('This account is already deleted');
    }

    // Frees the real email for reuse (register()/invite() existence checks
    // otherwise treat it as permanently taken) — same fix as the user's own
    // self-service deletion path in auth.service.ts.
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        status: 'DELETED',
        deletedAt: new Date(),
        email: `deleted-${targetUserId}@deleted.invalid`,
      },
    });
    await this.sessions.revokeAllForUser(targetUserId);
    await this.revocation.revokeUser(targetUserId);

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.user_deleted',
      targetType: 'User',
      targetId: targetUserId,
    });

    return { message: 'User account deleted' };
  }

  async forceLogout(
    adminUserId: string,
    targetUserId: string,
  ): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.sessions.revokeAllForUser(targetUserId);
    await this.revocation.revokeUser(targetUserId);

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.user_force_logout',
      targetType: 'User',
      targetId: targetUserId,
    });

    return { message: 'All sessions revoked for this user' };
  }

  /**
   * "View as this user" — mints a short-lived access token for support/admin
   * to see exactly what a customer sees, without knowing or resetting their
   * password. Blocked for other admins (a support rep viewing another
   * admin's account is a privilege-escalation path, not a support tool) and
   * for any account that isn't ACTIVE (nothing useful to view, and it would
   * bypass the same status check a real login enforces).
   */
  async impersonateUser(
    adminUserId: string,
    targetUserId: string,
  ): Promise<{ accessToken: string; targetEmail: string }> {
    if (adminUserId === targetUserId) {
      throw new ForbiddenException('You cannot impersonate your own account');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'ADMIN' || target.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Cannot impersonate an admin account');
    }
    if (target.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot impersonate an account with status ${target.status}`,
      );
    }

    const accessToken = await this.authService.signImpersonationToken(
      target.id,
      target.email,
      target.role,
      adminUserId,
    );

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.user_impersonated',
      targetType: 'User',
      targetId: targetUserId,
    });

    return { accessToken, targetEmail: target.email };
  }

  /**
   * Provisions access for an email that doesn't have an account yet,
   * without an admin ever setting a password on someone else's behalf —
   * the invited person still completes the real signup flow (their own
   * password, real ToS/Privacy consent) and register() applies the role
   * and Directory-access grant recorded here the moment they do. If the
   * email already has an account, use setDirectoryAccess on that user
   * directly instead — this is only for people who haven't signed up yet.
   */
  async inviteUser(
    adminUserId: string,
    dto: InviteUserDto,
  ): Promise<{ message: string }> {
    const email = dto.email.trim().toLowerCase();

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      throw new BadRequestException(
        'This email already has an account — grant or revoke Directory access on their existing user instead.',
      );
    }

    // Resend rather than duplicate: an admin retrying (or re-inviting with
    // different options) updates the one still-pending row instead of
    // piling up rows that'd all race to be "the" match in register().
    const pending = await this.prisma.adminAccessInvite.findFirst({
      where: { email, status: 'PENDING' },
      select: { id: true },
    });
    const inviteData = {
      invitedByUserId: adminUserId,
      role: dto.role ?? 'USER',
      grantDirectoryAccess: dto.grantDirectoryAccess ?? true,
    };
    if (pending) {
      await this.prisma.adminAccessInvite.update({
        where: { id: pending.id },
        data: inviteData,
      });
    } else {
      await this.prisma.adminAccessInvite.create({
        data: { ...inviteData, email },
      });
    }

    await this.email.sendAdminAccessInvite(
      email,
      dto.grantDirectoryAccess ?? true,
    );
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.user_invited',
      metadata: {
        email,
        role: dto.role ?? 'USER',
        grantDirectoryAccess: dto.grantDirectoryAccess ?? true,
      },
    });

    return { message: `Invite sent to ${email}.` };
  }

  /** Toggles the Stripe-independent comp flag on an existing account — see User.adminGrantedDirectoryAccess. */
  async setDirectoryAccess(
    adminUserId: string,
    targetUserId: string,
    dto: SetDirectoryAccessDto,
  ): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { adminGrantedDirectoryAccess: dto.granted },
    });
    await this.audit.record({
      actorUserId: adminUserId,
      action: dto.granted
        ? 'admin.directory_access_granted'
        : 'admin.directory_access_revoked',
      targetType: 'User',
      targetId: targetUserId,
    });

    return {
      message: dto.granted
        ? `Directory access granted to ${target.email}.`
        : `Directory access revoked for ${target.email}.`,
    };
  }

  /**
   * Signed-up accounts that have never once bought the Directory
   * subscription — real prospects, not people who paid and later
   * canceled. Excludes staff accounts (nothing to pitch them) and anyone
   * already comped via adminGrantedDirectoryAccess (already converted, in
   * the sense that matters here — no subscription needed, so re-pitching
   * them is noise). Oldest signup first: the longest someone has sat
   * without buying is the strongest signal they're worth reaching out to.
   */
  async listProspects(query: ListProspectsQueryDto): Promise<Page<unknown>> {
    const where: Prisma.UserWhereInput = {
      status: 'ACTIVE',
      role: { in: ['USER', 'PREMIUM'] },
      adminGrantedDirectoryAccess: false,
      subscriptions: { none: {} },
      ...(query.search && {
        OR: [
          { email: { contains: query.search, mode: 'insensitive' } },
          { fullName: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          fullName: true,
          createdAt: true,
          lastLoginAt: true,
        },
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    const now = Date.now();
    const enriched = data.map((user) => ({
      ...user,
      daysSinceSignup: Math.floor(
        (now - user.createdAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
    }));

    return { data: enriched, page: query.page, pageSize: query.pageSize, total };
  }

  async pitchProspect(
    adminUserId: string,
    targetUserId: string,
    dto: PitchProspectDto,
  ): Promise<{ message: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, fullName: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.email.sendProspectPitch(
      target.email,
      target.fullName,
      dto.template,
    );
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.prospect_pitched',
      targetType: 'User',
      targetId: targetUserId,
      metadata: { template: dto.template },
    });

    return { message: `${dto.template} pitch sent to ${target.email}.` };
  }

  // ── Subscriptions ────────────────────────────────────────────────────

  async listSubscriptions(
    query: ListSubscriptionsQueryDto,
  ): Promise<Page<unknown>> {
    const where: Prisma.SubscriptionWhereInput = { status: query.status };

    const [data, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        select: {
          id: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          trialEndsAt: true,
          pastDueSince: true,
          createdAt: true,
          user: { select: { id: true, email: true, fullName: true } },
          plan: { select: { name: true, amountCents: true, currency: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    return {
      data: data.map((sub) => ({
        ...sub,
        daysPastDue: daysPastDue(sub.pastDueSince),
        hasAccess: hasActiveAccess(sub, this.gracePeriodDays),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * Lead Finder's own subscription list — deliberately separate from
   * listSubscriptions above, not merged into one "all subscriptions" view.
   * The two products have different shapes (a tier + credits, not a flat
   * plan) and no admin page or revenue rollup surfaced this cohort at all
   * before this endpoint existed.
   */
  async listLeadFinderSubscriptions(
    query: ListSubscriptionsQueryDto,
  ): Promise<Page<unknown>> {
    const where: Prisma.LeadFinderSubscriptionWhereInput = {
      status: query.status,
    };

    const [data, total] = await Promise.all([
      this.prisma.leadFinderSubscription.findMany({
        where,
        select: {
          id: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          pastDueSince: true,
          createdAt: true,
          user: { select: { id: true, email: true, fullName: true } },
          tier: { select: { name: true, amountCents: true, currency: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.leadFinderSubscription.count({ where }),
    ]);

    return {
      data: data.map((sub) => ({
        ...sub,
        daysPastDue: daysPastDue(sub.pastDueSince),
        hasAccess: hasActiveAccess(sub, this.gracePeriodDays),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * Real revenue, grouped by the calendar month it was actually collected —
   * not "issued" or "due", since a failed/OPEN invoice never collected
   * anything. Combines two genuinely separate revenue sources that don't
   * share a table: the Directory plan bills through Stripe subscription
   * invoices (the `Invoice` table), while Lead Finder tiers and one-time
   * credit packs never create an Invoice row at all — they're recorded as
   * `CreditGrant`s the moment a real charge grants credits (see
   * LeadFinderBillingService.grantMonthlyCredits and the credits checkout
   * webhook handler). Without folding CreditGrant in here, Lead Finder's
   * entire revenue line — a real, distinct product — would be invisible to
   * admins. `source: ADMIN_ADJUSTMENT` grants are excluded via the
   * `amountPaidCents: { not: null }` filter, since those aren't real money.
   * Small enough result sets to aggregate in JS rather than a raw SQL query.
   */
  async getMonthlyRevenue(): Promise<
    {
      month: string;
      totalCents: number;
      directoryCents: number;
      leadFinderCents: number;
      currency: string;
      invoiceCount: number;
      creditGrantCount: number;
    }[]
  > {
    const [paidInvoices, paidCreditGrants] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { status: 'PAID', paidAt: { not: null } },
        select: { amountCents: true, currency: true, paidAt: true },
      }),
      this.prisma.creditGrant.findMany({
        where: { amountPaidCents: { not: null } },
        select: { amountPaidCents: true, createdAt: true },
      }),
    ]);

    const byMonth = new Map<
      string,
      {
        directoryCents: number;
        leadFinderCents: number;
        currency: string;
        invoiceCount: number;
        creditGrantCount: number;
      }
    >();
    const monthRow = (month: string) => {
      let row = byMonth.get(month);
      if (!row) {
        row = {
          directoryCents: 0,
          leadFinderCents: 0,
          currency: 'usd',
          invoiceCount: 0,
          creditGrantCount: 0,
        };
        byMonth.set(month, row);
      }
      return row;
    };

    for (const invoice of paidInvoices) {
      const row = monthRow(invoice.paidAt!.toISOString().slice(0, 7));
      row.directoryCents += invoice.amountCents;
      row.currency = invoice.currency;
      row.invoiceCount += 1;
    }
    for (const grant of paidCreditGrants) {
      const row = monthRow(grant.createdAt.toISOString().slice(0, 7));
      row.leadFinderCents += grant.amountPaidCents!;
      row.creditGrantCount += 1;
    }

    return [...byMonth.entries()]
      .map(([month, row]) => ({
        month,
        totalCents: row.directoryCents + row.leadFinderCents,
        directoryCents: row.directoryCents,
        leadFinderCents: row.leadFinderCents,
        currency: row.currency,
        invoiceCount: row.invoiceCount,
        creditGrantCount: row.creditGrantCount,
      }))
      .sort((a, b) => b.month.localeCompare(a.month));
  }

  // ── Audit logs ───────────────────────────────────────────────────────

  async listAuditLogs(query: ListAuditLogsQueryDto): Promise<Page<unknown>> {
    const where: Prisma.AuditLogWhereInput = {
      action: query.action ? { contains: query.action } : undefined,
      actorUserId: query.actorUserId,
      targetId: query.targetId,
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        select: {
          id: true,
          actorUserId: true,
          action: true,
          targetType: true,
          targetId: true,
          metadata: true,
          ipAddress: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  // ── Security ─────────────────────────────────────────────────────────

  /** The API surface a security dashboard would consume — every session at or above a risk score, across all users. */
  async listFlaggedSessions(
    query: ListFlaggedSessionsQueryDto,
  ): Promise<Page<unknown>> {
    const where: Prisma.SessionWhereInput = {
      riskScore: { gte: query.minScore },
    };

    const [data, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        select: {
          ...SESSION_SECURITY_SELECT,
          user: { select: { id: true, email: true, fullName: true } },
        },
        orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.session.count({ where }),
    ]);

    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  // ── Leads ────────────────────────────────────────────────────────────

  /**
   * Deliberately no SubscriptionGuard equivalent here — an admin manages
   * this data regardless of their own billing status. Same filter shape
   * as the public directory (LeadsService.buildWhere), reimplemented
   * rather than imported to keep this file's existing pattern (every
   * other admin resource — users, subscriptions, sessions — queries
   * Prisma directly here rather than delegating to another module's
   * service).
   */
  async listLeads(query: ListLeadsQueryDto): Promise<Page<unknown>> {
    const where: Prisma.LeadWhereInput = {
      companyType: query.companyType,
      likelyToAttend: query.likelyToAttend,
      approved: query.approved,
      ...(query.hasEmail && { email: { not: null } }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { company: { contains: query.search, mode: 'insensitive' } },
          { title: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

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

  /**
   * Same distinct-values query LeadsService.getFilters() runs for the paid
   * directory — reimplemented here rather than imported (matches this
   * file's existing pattern) since an admin managing lead data shouldn't
   * need an active subscription of their own to see it.
   */
  async getLeadFilters() {
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
    return {
      companyTypes: companyTypes.map((c) => c.companyType),
      events: events.map((e) => e.likelyToAttend),
    };
  }

  async createLead(adminUserId: string, dto: CreateLeadDto) {
    const lead = await this.prisma.lead.create({
      data: dto,
      select: LEAD_SELECT,
    });
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.lead_created',
      targetType: 'Lead',
      targetId: lead.id,
    });
    return lead;
  }

  /** Publishes a self-submitted lead (see PublicLeadsController.submitSelf) into the real, subscriber-visible directory. */
  async approveLead(adminUserId: string, leadId: string) {
    const existing = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, approved: true },
    });
    if (!existing) throw new NotFoundException('Lead not found');
    if (existing.approved) {
      throw new BadRequestException('This lead is already approved');
    }

    const lead = await this.prisma.lead.update({
      where: { id: leadId },
      data: { approved: true },
      select: LEAD_SELECT,
    });
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.lead_approved',
      targetType: 'Lead',
      targetId: leadId,
    });
    return lead;
  }

  async updateLead(adminUserId: string, leadId: string, dto: UpdateLeadDto) {
    const existing = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Lead not found');

    const lead = await this.prisma.lead.update({
      where: { id: leadId },
      data: dto,
      select: LEAD_SELECT,
    });
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.lead_updated',
      targetType: 'Lead',
      targetId: leadId,
    });
    return lead;
  }

  async deleteLead(adminUserId: string, leadId: string): Promise<void> {
    const existing = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Lead not found');

    await this.prisma.lead.delete({ where: { id: leadId } });
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.lead_deleted',
      targetType: 'Lead',
      targetId: leadId,
    });
  }

  // ── Contact messages ─────────────────────────────────────────────────

  async listContactMessages(
    query: ListContactMessagesQueryDto,
  ): Promise<Page<unknown>> {
    const where: Prisma.ContactMessageWhereInput = {
      resolved: query.resolved,
      reason: query.reason,
    };

    const [data, total] = await Promise.all([
      this.prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.contactMessage.count({ where }),
    ]);

    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  async resolveContactMessage(
    adminUserId: string,
    id: string,
  ): Promise<{ message: string }> {
    const existing = await this.prisma.contactMessage.findUnique({
      where: { id },
      select: { id: true, resolved: true },
    });
    if (!existing) throw new NotFoundException('Contact message not found');
    if (existing.resolved) {
      throw new BadRequestException('This message is already resolved');
    }

    await this.prisma.contactMessage.update({
      where: { id },
      data: { resolved: true },
    });
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.contact_message_resolved',
      targetType: 'ContactMessage',
      targetId: id,
    });

    return { message: 'Marked as resolved' };
  }

  /**
   * A submitted contact form message has no dependents in the schema (see
   * the ContactMessage model comment) and no billing/legal retention
   * requirement like a user account does — a hard delete is the right
   * "remove this" here, not a soft-delete pattern.
   */
  async deleteContactMessage(
    adminUserId: string,
    id: string,
  ): Promise<{ message: string }> {
    const existing = await this.prisma.contactMessage.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Contact message not found');

    await this.prisma.contactMessage.delete({ where: { id } });
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.contact_message_deleted',
      targetType: 'ContactMessage',
      targetId: id,
    });

    return { message: 'Message deleted' };
  }

  /** Sends the admin's reply to the original sender's email — the same address the message came in on, not a copy stored in-app. */
  async replyToContactMessage(
    adminUserId: string,
    id: string,
    dto: ReplyContactMessageDto,
  ): Promise<{ message: string }> {
    const existing = await this.prisma.contactMessage.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, message: true },
    });
    if (!existing) throw new NotFoundException('Contact message not found');

    await this.email.sendContactMessageReply(
      existing.email,
      existing.name,
      existing.message,
      dto.message,
    );
    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.contact_message_replied',
      targetType: 'ContactMessage',
      targetId: id,
    });

    return { message: `Reply sent to ${existing.email}.` };
  }
}
