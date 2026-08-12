import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type * as runtime from '@prisma/client/runtime/client';
import { Session } from '../../generated/prisma/client';
import { TokenService } from '../common/tokens/token.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateSessionInput {
  userId: string;
  deviceId: string | null;
  ipAddress: string | null;
  // All optional and only ever populated on a real login — a refresh-token
  // rotation's own internal call to create() leaves these at their schema
  // defaults, since a rotation isn't a new authentication event to
  // geolocate or risk-assess.
  country?: string | null;
  city?: string | null;
  timezone?: string | null;
  riskScore?: number;
  riskSignals?: runtime.InputJsonValue;
}

@Injectable()
export class SessionsService {
  private readonly refreshExpiryDays: number;
  private readonly maxConcurrentSessions: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {
    this.refreshExpiryDays = this.config.get<number>(
      'REFRESH_TOKEN_EXPIRY_DAYS',
      30,
    );
    this.maxConcurrentSessions = this.config.get<number>(
      'MAX_TRUSTED_DEVICES',
      3,
    );
  }

  /**
   * Called on every real login (not on refresh-token rotation — that's the
   * same session continuing, not a new device) before the new session is
   * created. If the account is already at the concurrent-session cap, signs
   * out its oldest session to make room, rather than blocking the new
   * login outright — the point is capping how many devices can be
   * simultaneously logged in, not annoying the account's real owner.
   */
  async enforceLimit(userId: string): Promise<void> {
    const active = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const overBy = active.length - this.maxConcurrentSessions + 1;
    if (overBy <= 0) return;
    await this.prisma.session.updateMany({
      where: { id: { in: active.slice(0, overBy).map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });
  }

  /** Returns the raw token exactly once — callers must put it in the cookie and never persist it themselves. */
  async create(
    input: CreateSessionInput,
  ): Promise<{ rawToken: string; session: Session }> {
    const rawToken = this.tokens.generateOpaqueToken();
    const tokenHash = this.tokens.hash(rawToken);
    const expiresAt = new Date(
      Date.now() + this.refreshExpiryDays * 86_400_000,
    );

    const session = await this.prisma.session.create({
      data: {
        userId: input.userId,
        deviceId: input.deviceId,
        tokenHash,
        ipAddress: input.ipAddress,
        expiresAt,
        country: input.country,
        city: input.city,
        timezone: input.timezone,
        riskScore: input.riskScore,
        riskSignals: input.riskSignals,
      },
    });

    return { rawToken, session };
  }

  /** Only matches non-revoked, non-expired sessions — the normal "is this refresh token still good" check. */
  findActiveByRawToken(rawToken: string): Promise<Session | null> {
    return this.prisma.session.findFirst({
      where: {
        tokenHash: this.tokens.hash(rawToken),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * Matches by hash regardless of revoked status — used specifically to
   * detect refresh-token *reuse*. A revoked token being presented again
   * means either a client double-submitted a stale token, or someone stole
   * it after it was already rotated. AuthService treats this as a theft
   * signal and revokes the whole session family.
   */
  findAnyByRawToken(rawToken: string): Promise<Session | null> {
    return this.prisma.session.findUnique({
      where: { tokenHash: this.tokens.hash(rawToken) },
    });
  }

  /** Used to walk a rotation chain's replacedByTokenId — see AuthService.refresh()'s concurrent-refresh grace window. */
  findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  /** Revokes `oldSession` and issues a fresh one linked to it via replacedByTokenId — this is refresh-token rotation. */
  async rotate(
    oldSession: Session,
    ipAddress: string | null,
  ): Promise<{ rawToken: string; session: Session }> {
    const { rawToken, session } = await this.create({
      userId: oldSession.userId,
      deviceId: oldSession.deviceId,
      ipAddress,
    });
    await this.prisma.session.update({
      where: { id: oldSession.id },
      data: { revokedAt: new Date(), replacedByTokenId: session.id },
    });
    return { rawToken, session };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
  }

  /** The "log out everywhere" / theft-response action. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async touchActivity(sessionId: string): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    });
  }

  /**
   * Deliberately excludes tokenHash and replacedByTokenId — internal
   * security bookkeeping with no reason to ever reach a client response,
   * even hashed. Same reasoning on the nested device: fingerprint is
   * excluded.
   */
  listActiveForUser(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: {
        id: true,
        deviceId: true,
        ipAddress: true,
        country: true,
        city: true,
        timezone: true,
        createdAt: true,
        lastActivityAt: true,
        expiresAt: true,
        device: {
          select: {
            id: true,
            browserName: true,
            browserVersion: true,
            os: true,
            deviceType: true,
            isTrusted: true,
            firstSeenAt: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { lastActivityAt: 'desc' },
    });
  }
}
