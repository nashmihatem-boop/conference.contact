import { Injectable, Logger } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateCampaignSettingsDto } from './dto/update-campaign-settings.dto';

const SETTINGS_ID = 'singleton';
const CHUNK_SIZE = 1_000;

// A domain with zero sending history can't safely absorb bounce/complaint
// noise the way an established one can — 3% combined bounce+complaint rate
// is well above what AWS SES tolerates before suspending the account
// (~5% bounce / ~0.1% complaint are its own thresholds), so tripping here
// leaves real margin. MIN_SAMPLE avoids pausing on a couple of unlucky
// early sends before the rate is statistically meaningful.
const CIRCUIT_BREAKER_MIN_SAMPLE = 20;
const CIRCUIT_BREAKER_MAX_BAD_RATE = 0.03;

export interface CampaignStats {
  pending: number;
  sent: number;
  skippedExistingUser: number;
  skippedUnsubscribed: number;
  bounced: number;
  complained: number;
  total: number;
  bounceComplaintRate: number;
  dailyCap: number;
  paused: boolean;
}

/**
 * Owns the cold-outreach drip queue: a CSV/paste upload lands here as
 * PENDING rows (see enqueueUploadedEmails) rather than sending immediately,
 * and a once-daily job (ProspectCampaignProcessor) sends a capped batch —
 * a brand-new sending domain can't safely absorb a 17,000-email blast in
 * one shot. Every row is re-checked against User/EmailSuppression again at
 * actual send time, not just upload time, since weeks may pass between the
 * two for a row near the back of the queue.
 */
@Injectable()
export class ProspectCampaignService {
  private readonly logger = new Logger(ProspectCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  async enqueueUploadedEmails(
    uploadedByUserId: string,
    rawEmails: string[],
  ): Promise<{
    queued: number;
    alreadyQueued: number;
    alreadyHasAccount: number;
    unsubscribed: number;
    invalid: number;
    total: number;
  }> {
    const normalized = rawEmails.map((raw) => raw.trim().toLowerCase());
    const valid = new Set<string>();
    let invalid = 0;
    for (const email of normalized) {
      if (isEmail(email)) {
        valid.add(email);
      } else {
        invalid += 1;
      }
    }

    const candidates = [...valid];
    const existingUsers = new Set<string>();
    const suppressed = new Set<string>();
    const alreadyQueued = new Set<string>();

    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);
      const [users, suppressions, queued] = await Promise.all([
        this.prisma.user.findMany({
          where: { email: { in: chunk } },
          select: { email: true },
        }),
        this.prisma.emailSuppression.findMany({
          where: { email: { in: chunk } },
          select: { email: true },
        }),
        this.prisma.prospectInviteQueue.findMany({
          where: { email: { in: chunk } },
          select: { email: true },
        }),
      ]);
      for (const u of users) existingUsers.add(u.email);
      for (const s of suppressions) suppressed.add(s.email);
      for (const q of queued) alreadyQueued.add(q.email);
    }

    const toQueue = candidates.filter(
      (email) =>
        !existingUsers.has(email) &&
        !suppressed.has(email) &&
        !alreadyQueued.has(email),
    );

    if (toQueue.length > 0) {
      await this.prisma.prospectInviteQueue.createMany({
        data: toQueue.map((email) => ({ email, uploadedByUserId })),
        skipDuplicates: true,
      });
    }

    await this.audit.record({
      actorUserId: uploadedByUserId,
      action: 'admin.prospect_campaign_uploaded',
      metadata: {
        total: rawEmails.length,
        queued: toQueue.length,
        alreadyQueued: alreadyQueued.size,
        alreadyHasAccount: existingUsers.size,
        unsubscribed: suppressed.size,
        invalid,
      },
    });

    return {
      queued: toQueue.length,
      alreadyQueued: alreadyQueued.size,
      alreadyHasAccount: existingUsers.size,
      unsubscribed: suppressed.size,
      invalid,
      total: rawEmails.length,
    };
  }

  async getStats(): Promise<CampaignStats> {
    const [statusCounts, settings] = await Promise.all([
      this.prisma.prospectInviteQueue.groupBy({
        by: ['status'],
        _count: true,
      }),
      this.getOrCreateSettings(),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusCounts) byStatus[row.status] = row._count;

    const sent = byStatus.SENT ?? 0;
    const bounced = byStatus.BOUNCED ?? 0;
    const complained = byStatus.COMPLAINED ?? 0;
    const attempted = sent + bounced + complained;

    return {
      pending: byStatus.PENDING ?? 0,
      sent,
      skippedExistingUser: byStatus.SKIPPED_EXISTING_USER ?? 0,
      skippedUnsubscribed: byStatus.SKIPPED_UNSUBSCRIBED ?? 0,
      bounced,
      complained,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      bounceComplaintRate:
        attempted > 0 ? (bounced + complained) / attempted : 0,
      dailyCap: settings.dailyCap,
      paused: settings.paused,
    };
  }

  async updateSettings(
    adminUserId: string,
    dto: UpdateCampaignSettingsDto,
  ): Promise<{ dailyCap: number; paused: boolean }> {
    const data = {
      ...(dto.dailyCap !== undefined && { dailyCap: dto.dailyCap }),
      ...(dto.paused !== undefined && { paused: dto.paused }),
    };
    const updated = await this.prisma.prospectInviteCampaignSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data },
      update: data,
    });

    await this.audit.record({
      actorUserId: adminUserId,
      action: 'admin.prospect_campaign_settings_updated',
      metadata: { dailyCap: updated.dailyCap, paused: updated.paused },
    });

    return { dailyCap: updated.dailyCap, paused: updated.paused };
  }

  /** Called from the Resend webhook (see ResendWebhookController) — a hard bounce means the address is dead, never worth retrying cold or otherwise. */
  async markBounced(email: string): Promise<void> {
    await this.suppressAndUpdateStatus(email, 'BOUNCED');
  }

  /** A spam complaint is the single strongest signal to never contact this address again. */
  async markComplained(email: string): Promise<void> {
    await this.suppressAndUpdateStatus(email, 'COMPLAINED');
  }

  /**
   * The daily drip: sends up to dailyCap PENDING rows, oldest first. Runs a
   * bounce/complaint circuit breaker first — if the campaign's overall bad
   * rate has crossed the safety threshold, it auto-pauses and skips
   * sending entirely rather than compounding the damage while someone
   * notices the dashboard.
   */
  async runDailyDrip(): Promise<void> {
    const settings = await this.getOrCreateSettings();
    if (settings.paused) {
      this.logger.log("Prospect campaign is paused — skipping today's drip.");
      return;
    }

    const tripped = await this.checkAndApplyCircuitBreaker();
    if (tripped) return;

    const candidates = await this.prisma.prospectInviteQueue.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: settings.dailyCap,
    });
    if (candidates.length === 0) return;

    const emails = candidates.map((c) => c.email);
    const [existingUsers, suppressions] = await Promise.all([
      this.prisma.user.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      }),
      this.prisma.emailSuppression.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      }),
    ]);
    const existingSet = new Set(existingUsers.map((u) => u.email));
    const suppressedSet = new Set(suppressions.map((s) => s.email));

    const toSend: string[] = [];
    let skippedExisting = 0;
    let skippedUnsubscribed = 0;
    for (const candidate of candidates) {
      if (existingSet.has(candidate.email)) {
        await this.prisma.prospectInviteQueue.update({
          where: { id: candidate.id },
          data: { status: 'SKIPPED_EXISTING_USER' },
        });
        skippedExisting += 1;
      } else if (suppressedSet.has(candidate.email)) {
        await this.prisma.prospectInviteQueue.update({
          where: { id: candidate.id },
          data: { status: 'SKIPPED_UNSUBSCRIBED' },
        });
        skippedUnsubscribed += 1;
      } else {
        toSend.push(candidate.email);
      }
    }

    if (toSend.length > 0) {
      await this.email.sendProspectInviteBulk(toSend);
      await this.prisma.prospectInviteQueue.updateMany({
        where: { email: { in: toSend } },
        data: { status: 'SENT', sentAt: new Date() },
      });
    }

    await this.audit.record({
      action: 'admin.prospect_campaign_daily_drip',
      metadata: {
        batchSize: candidates.length,
        sent: toSend.length,
        skippedExisting,
        skippedUnsubscribed,
      },
    });
    this.logger.log(
      `Prospect campaign drip: sent ${toSend.length}, skipped ${skippedExisting + skippedUnsubscribed} of ${candidates.length} candidates.`,
    );
  }

  private async checkAndApplyCircuitBreaker(): Promise<boolean> {
    const counts = await this.prisma.prospectInviteQueue.groupBy({
      by: ['status'],
      where: { status: { in: ['SENT', 'BOUNCED', 'COMPLAINED'] } },
      _count: true,
    });
    const byStatus: Record<string, number> = {};
    for (const row of counts) byStatus[row.status] = row._count;
    const sent = byStatus.SENT ?? 0;
    const bounced = byStatus.BOUNCED ?? 0;
    const complained = byStatus.COMPLAINED ?? 0;
    const attempted = sent + bounced + complained;

    if (attempted < CIRCUIT_BREAKER_MIN_SAMPLE) return false;
    const badRate = (bounced + complained) / attempted;
    if (badRate <= CIRCUIT_BREAKER_MAX_BAD_RATE) return false;

    await this.prisma.prospectInviteCampaignSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, paused: true },
      update: { paused: true },
    });
    await this.audit.record({
      action: 'admin.prospect_campaign_auto_paused',
      metadata: { attempted, bounced, complained, badRate },
    });
    this.logger.warn(
      `Prospect campaign auto-paused: ${(badRate * 100).toFixed(2)}% bounce/complaint rate over ${attempted} sends.`,
    );
    return true;
  }

  private async suppressAndUpdateStatus(
    rawEmail: string,
    status: 'BOUNCED' | 'COMPLAINED',
  ): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    await this.prisma.emailSuppression.upsert({
      where: { email },
      create: { email },
      update: {},
    });
    await this.prisma.prospectInviteQueue.updateMany({
      where: { email, status: 'SENT' },
      data: { status },
    });
  }

  private async getOrCreateSettings() {
    return this.prisma.prospectInviteCampaignSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }
}
