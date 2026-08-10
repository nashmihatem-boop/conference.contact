import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type * as runtime from '@prisma/client/runtime/client';
import * as argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import {
  generateSecret as generateTotpSecret,
  generateURI as generateTotpUri,
  verify as verifyTotp,
} from 'otplib';
import * as qrcode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { StripeService } from '../billing/stripe.service';
import {
  DeviceDescriptor,
  describeUserAgent,
  hashDeviceId,
} from '../common/device/device-fingerprint.util';
import { EncryptionService } from '../common/encryption/encryption.service';
import { GeoipService } from '../common/geoip/geoip.service';
import { TokenRevocationService } from '../common/token-revocation/token-revocation.service';
import { TokenService } from '../common/tokens/token.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { DevicesService } from '../sessions/devices.service';
import { RiskService } from '../sessions/risk.service';
import { SessionsService } from '../sessions/sessions.service';
import { UsersService } from '../users/users.service';
import {
  EMAIL_VERIFICATION_EXPIRY_HOURS,
  LEGAL_DOCUMENT_VERSIONS,
  LOGIN_CHALLENGE_EXPIRY_MINUTES,
  PASSWORD_RESET_EXPIRY_HOURS,
} from './constants';
import { VerifyLoginDto } from './dto/verify-login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import {
  AccessTokenPayload,
  LoginChallengePayload,
} from './types/jwt-payload.interface';

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | undefined;
  rawDeviceId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  // OWASP-recommended baseline for argon2id as of 2024/2025 guidance.
  memoryCost: 19_456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class AuthService {
  private readonly riskHighThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly stripe: StripeService,
    private readonly geoip: GeoipService,
    private readonly risk: RiskService,
    private readonly revocation: TokenRevocationService,
  ) {
    this.riskHighThreshold = this.config.get<number>('RISK_HIGH_THRESHOLD', 50);
  }

  // ── Registration & email verification ──────────────────────────────────

  async register(
    dto: RegisterDto,
    meta: RequestMeta,
  ): Promise<{ message: string }> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      // Same response shape as success would be tempting for enumeration
      // resistance, but registration UX generally needs to tell the user
      // they already have an account — we accept that trade-off here
      // (unlike login/forgot-password, where we don't).
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: this.users.normalizeEmail(dto.email),
          fullName: dto.fullName,
          passwordHash,
          phone: dto.phone,
        },
      });
      await tx.consentRecord.createMany({
        data: [
          {
            userId: created.id,
            documentType: 'TERMS',
            version: LEGAL_DOCUMENT_VERSIONS.TERMS,
            ipAddress: meta.ipAddress,
          },
          {
            userId: created.id,
            documentType: 'PRIVACY',
            version: LEGAL_DOCUMENT_VERSIONS.PRIVACY,
            ipAddress: meta.ipAddress,
          },
        ],
      });
      // Reconcile against any invite(s) that led here — purely informational
      // (lets an inviter see "joined" on their sent-invites list), never
      // grants this new, fully independent account any special access.
      await tx.invite.updateMany({
        where: { email: created.email, status: 'PENDING' },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      return created;
    });

    await this.issueVerificationToken(
      user.id,
      user.email,
      'EMAIL_VERIFICATION',
    );
    await this.email.sendWelcomeEmail(user.email, user.fullName);
    await this.audit.record({
      actorUserId: user.id,
      action: 'auth.register',
      ipAddress: meta.ipAddress,
    });

    return {
      message: 'Account created. Check your email to verify your address.',
    };
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<{ message: string }> {
    const record = await this.consumeVerificationToken(
      dto.token,
      'EMAIL_VERIFICATION',
    );
    await this.users.markEmailVerified(record.userId);
    await this.audit.record({
      actorUserId: record.userId,
      action: 'auth.email_verified',
    });
    return { message: 'Email verified — you can now log in.' };
  }

  // ── Login ────────────────────────────────────────────────────────────

  async login(
    dto: LoginDto,
    meta: RequestMeta,
  ): Promise<
    | ({ requiresVerification: false } & TokenPair)
    | {
        requiresVerification: true;
        method: 'EMAIL_CODE' | 'TOTP';
        challengeToken: string;
      }
  > {
    const user = await this.users.findByEmail(dto.email);
    // Same error for "no such user" and "wrong password" — don't let this
    // endpoint be used to enumerate registered emails.
    const genericError = () =>
      new UnauthorizedException('Invalid email or password');

    if (!user) throw genericError();

    if (this.users.isLocked(user)) {
      throw new UnauthorizedException(
        'Too many failed login attempts. Try again later.',
      );
    }
    if (user.status !== 'ACTIVE') {
      // Deliberately doesn't distinguish SUSPENDED from DELETED, matching
      // genericError() above — an inactive account shouldn't leak which
      // state it's in to whoever is attempting the login.
      throw new UnauthorizedException(
        'This account is not active. Contact us if you believe this is a mistake.',
      );
    }

    const passwordValid = await argon2
      .verify(user.passwordHash, dto.password)
      .catch(() => false);
    if (!passwordValid) {
      const { locked } = await this.users.registerFailedLogin(user.id);
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.login_failed',
        ipAddress: meta.ipAddress,
      });
      if (locked) {
        throw new UnauthorizedException(
          'Too many failed login attempts. This account is temporarily locked.',
        );
      }
      throw genericError();
    }

    await this.users.resetFailedLogins(user.id);

    const fingerprint = hashDeviceId(meta.rawDeviceId);
    const descriptor: DeviceDescriptor = describeUserAgent(meta.userAgent);
    const { device, isNew } = await this.devices.findOrCreateDevice(
      user.id,
      fingerprint,
      descriptor,
    );

    if (isNew) {
      if (user.twoFactorEnabled) {
        const challengeToken = await this.signChallenge({
          sub: user.id,
          deviceId: device.id,
          type: 'login_challenge',
          method: 'TOTP',
        });
        await this.audit.record({
          actorUserId: user.id,
          action: 'auth.new_device_challenge',
          metadata: { deviceId: device.id, method: 'TOTP' },
          ipAddress: meta.ipAddress,
        });
        return { requiresVerification: true, method: 'TOTP', challengeToken };
      }

      const code = this.tokens.generateNumericCode();
      const challengeToken = await this.signChallenge({
        sub: user.id,
        deviceId: device.id,
        type: 'login_challenge',
        method: 'EMAIL_CODE',
        codeHash: this.tokens.hash(code),
      });
      await this.email.sendDeviceVerificationCode(user.email, code);
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.new_device_challenge',
        metadata: { deviceId: device.id, method: 'EMAIL_CODE' },
        ipAddress: meta.ipAddress,
      });
      return {
        requiresVerification: true,
        method: 'EMAIL_CODE',
        challengeToken,
      };
    }

    const tokenPair = await this.issueTokenPair(
      user.id,
      device.id,
      meta,
      false,
    );
    return { requiresVerification: false, ...tokenPair };
  }

  async verifyLogin(
    dto: VerifyLoginDto,
    meta: RequestMeta,
  ): Promise<TokenPair> {
    let payload: LoginChallengePayload;
    try {
      payload = await this.jwt.verifyAsync<LoginChallengePayload>(
        dto.challengeToken,
      );
    } catch {
      throw new UnauthorizedException(
        'Verification expired — please log in again',
      );
    }
    if (payload.type !== 'login_challenge') {
      throw new UnauthorizedException('Invalid verification token');
    }

    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException('Account not found');

    // Independent of the per-IP throttle on this route — caps guesses
    // against this *specific* challenge regardless of how many source IPs
    // they're spread across. See TokenRevocationService.registerChallengeAttempt.
    const withinAttemptCap = await this.revocation.registerChallengeAttempt(
      dto.challengeToken,
      LOGIN_CHALLENGE_EXPIRY_MINUTES * 60,
    );
    if (!withinAttemptCap) {
      throw new UnauthorizedException(
        'Too many attempts — please log in again',
      );
    }

    let codeValid: boolean;
    if (payload.method === 'TOTP') {
      if (!user.twoFactorSecret)
        throw new UnauthorizedException('2FA is not set up on this account');
      const secret = this.encryption.decrypt(user.twoFactorSecret);
      codeValid = (await verifyTotp({ token: dto.code, secret })).valid;
    } else {
      if (!payload.codeHash) {
        throw new UnauthorizedException('Invalid verification token');
      }
      // Fixed-length SHA-256 hex digests on both sides, so a constant-time
      // comparison is always safe here (no length-mismatch edge case to
      // handle) — closes a timing side-channel `===` would otherwise leave
      // open on the code hash comparison.
      const submittedHash = Buffer.from(this.tokens.hash(dto.code));
      const expectedHash = Buffer.from(payload.codeHash);
      codeValid =
        submittedHash.length === expectedHash.length &&
        timingSafeEqual(submittedHash, expectedHash);
    }

    if (!codeValid) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.device_verification_failed',
        ipAddress: meta.ipAddress,
      });
      throw new UnauthorizedException('Invalid code');
    }

    // Reaching login/verify at all means a challenge was required, which
    // only ever happens for a device login() hadn't seen before — so this
    // call is always for a new device by construction, not something that
    // needs re-deriving from device.firstSeenAt/lastSeenAt.
    return this.issueTokenPair(user.id, payload.deviceId, meta, true);
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  async refresh(
    rawRefreshToken: string,
    meta: RequestMeta,
  ): Promise<TokenPair> {
    const session = await this.sessions.findActiveByRawToken(rawRefreshToken);

    if (!session) {
      const anySession = await this.sessions.findAnyByRawToken(rawRefreshToken);
      if (anySession?.revokedAt) {
        // A revoked refresh token being presented again means it was
        // either replayed by a client bug or stolen after rotation.
        // Either way, the safe response is to kill every session on the
        // account rather than trust anything currently active.
        await this.sessions.revokeAllForUser(anySession.userId);
        await this.audit.record({
          actorUserId: anySession.userId,
          action: 'auth.refresh_token_reuse_detected',
          metadata: { sessionId: anySession.id },
          ipAddress: meta.ipAddress,
        });
      }
      throw new UnauthorizedException('Session expired — please log in again');
    }

    const user = await this.users.findById(session.userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.sessions.revoke(session.id);
      throw new UnauthorizedException('Account is not active');
    }

    const { rawToken, session: newSession } = await this.sessions.rotate(
      session,
      meta.ipAddress,
    );
    const accessToken = await this.signAccessToken(
      user.id,
      user.email,
      user.role,
    );

    return {
      accessToken,
      refreshToken: rawToken,
      refreshTokenExpiresAt: newSession.expiresAt,
    };
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const session = await this.sessions.findActiveByRawToken(rawRefreshToken);
    if (session) {
      await this.sessions.revoke(session.id);
      await this.audit.record({
        actorUserId: session.userId,
        action: 'auth.logout',
      });
    }
    // No error if the token was already invalid — logout is idempotent.
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
    await this.revocation.revokeUser(userId);
    await this.audit.record({ actorUserId: userId, action: 'auth.logout_all' });
  }

  // ── Password reset ───────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const user = await this.users.findByEmail(dto.email);
    // Always the same response — confirming or denying an email is
    // registered via this endpoint is an enumeration vector.
    if (user) {
      await this.issueVerificationToken(user.id, user.email, 'PASSWORD_RESET');
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
      });
    }
    return {
      message:
        'If an account with that email exists, a reset link has been sent.',
    };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const record = await this.consumeVerificationToken(
      dto.token,
      'PASSWORD_RESET',
    );
    const passwordHash = await argon2.hash(dto.newPassword, ARGON2_OPTIONS);
    await this.users.updatePasswordHash(record.userId, passwordHash);
    // A password reset is a strong signal the old sessions should not be
    // trusted anymore — whoever had them may be exactly who this reset is
    // defending against. Revoking refresh tokens alone would still leave a
    // just-stolen access token usable for its remaining TTL, so this also
    // kills any access token outstanding right now.
    await this.sessions.revokeAllForUser(record.userId);
    await this.revocation.revokeUser(record.userId);
    await this.audit.record({
      actorUserId: record.userId,
      action: 'auth.password_reset_completed',
    });
    return { message: 'Password updated. Please log in again.' };
  }

  // ── 2FA (TOTP) ───────────────────────────────────────────────────────

  async start2fa(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();
    if (user.twoFactorEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already enabled',
      );
    }

    const secret = generateTotpSecret();
    await this.users.setTwoFactorSecret(
      userId,
      this.encryption.encrypt(secret),
    );

    const otpauthUrl = generateTotpUri({
      issuer: 'conference.contact',
      label: user.email,
      secret,
    });
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

    return { secret, otpauthUrl, qrCodeDataUrl };
  }

  async confirm2fa(userId: string, code: string): Promise<{ message: string }> {
    const user = await this.users.findById(userId);
    if (!user?.twoFactorSecret) {
      throw new BadRequestException('Start 2FA setup before confirming it');
    }

    const secret = this.encryption.decrypt(user.twoFactorSecret);
    const { valid } = await verifyTotp({ token: code, secret });
    if (!valid) {
      throw new UnauthorizedException('Invalid code');
    }

    await this.users.enableTwoFactor(userId);
    await this.audit.record({
      actorUserId: userId,
      action: 'auth.2fa_enabled',
    });
    return { message: 'Two-factor authentication enabled' };
  }

  async disable2fa(
    userId: string,
    password: string,
  ): Promise<{ message: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();

    const passwordValid = await argon2
      .verify(user.passwordHash, password)
      .catch(() => false);
    if (!passwordValid) throw new UnauthorizedException('Incorrect password');

    await this.users.disableTwoFactor(userId);
    await this.audit.record({
      actorUserId: userId,
      action: 'auth.2fa_disabled',
    });
    return { message: 'Two-factor authentication disabled' };
  }

  // ── Devices & sessions (user-facing) ────────────────────────────────

  listDevices(userId: string) {
    return this.devices.listForUser(userId);
  }

  listSessions(userId: string) {
    return this.sessions.listActiveForUser(userId);
  }

  async trustDevice(userId: string, deviceId: string) {
    const device = await this.devices.trust(userId, deviceId);
    await this.audit.record({
      actorUserId: userId,
      action: 'auth.device_trusted',
      targetId: deviceId,
    });
    return device;
  }

  async removeDevice(userId: string, deviceId: string): Promise<void> {
    await this.devices.remove(userId, deviceId);
    await this.audit.record({
      actorUserId: userId,
      action: 'auth.device_removed',
      targetId: deviceId,
    });
  }

  // ── GDPR: data export & account erasure ─────────────────────────────

  /**
   * Everything personal data this account holds, in one payload — the
   * "right of access" (GDPR Art. 15). Every query below uses an explicit
   * `select`, the same rule the rest of this service follows for
   * client-facing reads: never let a new sensitive column (passwordHash,
   * twoFactorSecret, tokenHash, fingerprint, ...) reach a response just
   * because it got added to the schema.
   */
  async exportData(userId: string) {
    const [
      profile,
      devices,
      sessions,
      subscriptions,
      consentRecords,
      auditLogs,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
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
          updatedAt: true,
        },
      }),
      this.prisma.device.findMany({
        where: { userId },
        select: {
          id: true,
          browserName: true,
          browserVersion: true,
          os: true,
          deviceType: true,
          isTrusted: true,
          trustedAt: true,
          firstSeenAt: true,
          lastSeenAt: true,
        },
      }),
      this.prisma.session.findMany({
        where: { userId },
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
          revokedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subscription.findMany({
        where: { userId },
        select: {
          id: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          trialEndsAt: true,
          createdAt: true,
          plan: {
            select: {
              name: true,
              interval: true,
              amountCents: true,
              currency: true,
            },
          },
          invoices: {
            select: {
              id: true,
              amountCents: true,
              currency: true,
              status: true,
              pdfUrl: true,
              paidAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.consentRecord.findMany({
        where: { userId },
        select: {
          documentType: true,
          version: true,
          ipAddress: true,
          acceptedAt: true,
        },
      }),
      this.prisma.auditLog.findMany({
        where: { actorUserId: userId },
        select: {
          action: true,
          targetType: true,
          targetId: true,
          ipAddress: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!profile) throw new UnauthorizedException();

    await this.audit.record({
      actorUserId: userId,
      action: 'auth.data_export_requested',
    });

    return {
      generatedAt: new Date().toISOString(),
      profile,
      devices,
      sessions,
      subscriptions,
      consentRecords,
      auditLogs,
    };
  }

  /**
   * The "right to erasure" (GDPR Art. 17) counterpart to `exportData`. This
   * is a soft delete on purpose — status flips to DELETED and every session
   * is revoked immediately, but the row itself stays put so billing/audit
   * history isn't silently lost (see the `deletedAt` comment in schema.prisma).
   * Hard erasure is a deliberate, separate admin/background job.
   *
   * Requires the current password so a hijacked access token alone can't
   * destroy the account, matching the same confirmation `disable2fa` uses.
   */
  async deleteAccount(
    userId: string,
    dto: DeleteAccountDto,
  ): Promise<{ message: string }> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();

    const passwordValid = await argon2
      .verify(user.passwordHash, dto.password)
      .catch(() => false);
    if (!passwordValid) throw new UnauthorizedException('Incorrect password');

    // Cancelled immediately (not at period end) — continuing to bill someone
    // who just asked to be erased isn't defensible. This calls out to Stripe
    // before the local transaction since there's nothing to roll back to if
    // the external call fails; safer to bail before touching local state.
    const activeSubscription = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    });
    if (activeSubscription) {
      await this.stripe.client.subscriptions.cancel(
        activeSubscription.stripeSubscriptionId,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (activeSubscription) {
        await tx.subscription.update({
          where: { id: activeSubscription.id },
          data: { status: 'CANCELED', cancelAtPeriodEnd: false },
        });
      }
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // The real email is freed up (not just left on a DELETED row) so the
      // same address can register or be invited again later — `email` is
      // globally @unique, and without this a soft-deleted account would
      // permanently squat the address forever, which findByEmail's
      // register()/invite() existence checks don't account for.
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          deletedAt: new Date(),
          email: `deleted-${userId}@deleted.invalid`,
        },
      });
    });
    await this.revocation.revokeUser(userId);

    await this.audit.record({
      actorUserId: userId,
      action: 'auth.account_deletion_requested',
    });

    return { message: 'Your account has been deleted.' };
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async issueTokenPair(
    userId: string,
    deviceId: string,
    meta: RequestMeta,
    isNewDevice: boolean,
  ): Promise<TokenPair> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();

    const geo = this.geoip.lookup(meta.ipAddress);
    const risk = await this.risk.assess({
      userId: user.id,
      isNewDevice,
      country: geo?.country ?? null,
      failedLoginCount: user.failedLoginCount,
    });

    // Enforced here, not inside sessions.create() — that method is shared
    // with refresh-token rotation, which continues an existing session
    // rather than starting a new one and must never evict anything.
    await this.sessions.enforceLimit(user.id);

    const [accessToken, sessionResult] = await Promise.all([
      this.signAccessToken(user.id, user.email, user.role),
      this.sessions.create({
        userId: user.id,
        deviceId,
        ipAddress: meta.ipAddress,
        country: geo?.country ?? null,
        city: geo?.city ?? null,
        timezone: geo?.timezone ?? null,
        riskScore: risk.score,
        riskSignals: risk.signals as runtime.InputJsonValue,
      }),
    ]);

    await this.users.updateLastLogin(user.id);
    await this.audit.record({
      actorUserId: user.id,
      action: 'auth.login',
      metadata: { deviceId, sessionId: sessionResult.session.id },
      ipAddress: meta.ipAddress,
    });

    // A separate, distinctly-named entry rather than folding this into the
    // auth.login row above — it's what the admin flagged-sessions view and
    // GET /admin/audit-logs?action=auth.high_risk_login filter on, and
    // conflating "every login" with "logins worth a second look" would
    // make both queries noisier.
    if (risk.score >= this.riskHighThreshold) {
      await this.audit.record({
        actorUserId: user.id,
        action: 'auth.high_risk_login',
        targetType: 'Session',
        targetId: sessionResult.session.id,
        metadata: {
          score: risk.score,
          signals: risk.signals,
        } as runtime.InputJsonValue,
        ipAddress: meta.ipAddress,
      });
    }

    return {
      accessToken,
      refreshToken: sessionResult.rawToken,
      refreshTokenExpiresAt: sessionResult.session.expiresAt,
    };
  }

  /**
   * Mints a real, valid access token for `targetUserId` without their
   * password — used only by AdminService.impersonateUser. Deliberately a
   * much shorter expiry than a normal login (10 minutes, not 15) since
   * this is a more sensitive credential, and carries `impersonatedBy` so
   * the token is self-describing even outside the audit log.
   */
  signImpersonationToken(
    targetUserId: string,
    targetEmail: string,
    targetRole: AccessTokenPayload['role'],
    adminUserId: string,
  ) {
    const payload: AccessTokenPayload = {
      sub: targetUserId,
      email: targetEmail,
      role: targetRole,
      type: 'access',
      impersonatedBy: adminUserId,
    };
    return this.jwt.signAsync(payload, { expiresIn: 600 });
  }

  private signAccessToken(
    sub: string,
    email: string,
    role: AccessTokenPayload['role'],
  ) {
    const payload: AccessTokenPayload = { sub, email, role, type: 'access' };
    return this.jwt.signAsync(payload, {
      // Numeric seconds, not a duration string ("15m") — @nestjs/jwt's
      // JwtSignOptions expects `number | StringValue` where StringValue is
      // a branded literal-pattern type from `ms`; a plain runtime string
      // from ConfigService doesn't satisfy that at compile time even
      // though it'd work fine at runtime. Seconds sidestep the mismatch
      // entirely and are unambiguous.
      expiresIn: this.config.get<number>('JWT_ACCESS_EXPIRY_SECONDS', 900),
    });
  }

  private signChallenge(payload: LoginChallengePayload) {
    return this.jwt.signAsync(payload, {
      expiresIn: LOGIN_CHALLENGE_EXPIRY_MINUTES * 60,
    });
  }

  private async issueVerificationToken(
    userId: string,
    email: string,
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ): Promise<void> {
    // Invalidate any previous unused token of the same purpose so only the
    // most recently requested link actually works.
    await this.prisma.verificationToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = this.tokens.generateOpaqueToken();
    const hours =
      purpose === 'EMAIL_VERIFICATION'
        ? EMAIL_VERIFICATION_EXPIRY_HOURS
        : PASSWORD_RESET_EXPIRY_HOURS;

    await this.prisma.verificationToken.create({
      data: {
        userId,
        tokenHash: this.tokens.hash(rawToken),
        purpose,
        expiresAt: new Date(Date.now() + hours * 3_600_000),
      },
    });

    if (purpose === 'EMAIL_VERIFICATION') {
      await this.email.sendVerificationEmail(email, rawToken);
    } else {
      await this.email.sendPasswordResetEmail(email, rawToken);
    }
  }

  private async consumeVerificationToken(
    rawToken: string,
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ) {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.tokens.hash(rawToken) },
    });

    if (!record || record.purpose !== purpose) {
      throw new BadRequestException('Invalid or expired link');
    }
    if (record.usedAt) {
      throw new BadRequestException('This link has already been used');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This link has expired');
    }

    await this.prisma.verificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    return record;
  }
}
