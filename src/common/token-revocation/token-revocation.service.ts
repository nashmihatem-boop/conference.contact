import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../queue/queue.module';

const KEY_PREFIX = 'revoked:user:';
const CHALLENGE_ATTEMPT_PREFIX = 'login-challenge-attempts:';
const MAX_CHALLENGE_ATTEMPTS = 5;

/**
 * Closes the gap access tokens' statelessness otherwise leaves open: an
 * admin suspending a user (or, generically, any "kill this account's
 * access right now" action) can't invalidate a JWT that's already been
 * handed out — JwtAuthGuard verifies it by signature alone, with no
 * database round-trip. This is the minimal fix that doesn't give that up:
 * one fast Redis EXISTS check per request, not a full session/DB lookup.
 *
 * The revocation key's TTL matches JWT_ACCESS_EXPIRY_SECONDS — the longest
 * an already-issued token could still be valid for — so the key expires
 * itself exactly when it stops being able to matter. Refresh tokens are
 * already revoked separately (SessionsService), so once this key expires
 * the user simply can't get a new access token anyway.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);
  private readonly accessTokenTtlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {
    this.accessTokenTtlSeconds = this.config.get<number>(
      'JWT_ACCESS_EXPIRY_SECONDS',
      900,
    );
  }

  /**
   * Swallows a Redis failure rather than letting it fail the caller's
   * overall action (e.g. AdminService.suspendUser has already durably
   * revoked refresh tokens and flipped the account status in Postgres by
   * the time this runs) — this write is the same defense-in-depth layer
   * as isRevoked, not the primary mechanism, so it shouldn't be able to
   * turn "Redis is briefly unreachable" into "suspending a user fails
   * outright."
   */
  async revokeUser(userId: string): Promise<void> {
    try {
      await this.redis.set(
        `${KEY_PREFIX}${userId}`,
        '1',
        'EX',
        this.accessTokenTtlSeconds,
      );
    } catch (err) {
      this.logger.error(
        `Redis unavailable — could not write instant revocation for user ${userId} (refresh-token revocation still applies normally): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Called on every authenticated request (JwtAuthGuard), so a Redis
   * outage can't become an outage of the entire API — this is a
   * defense-in-depth check on top of JWT signature verification, not the
   * primary security boundary (that's still refresh-token revocation,
   * backed by Postgres). Failing open here trades a narrow, temporary
   * window — an already-issued token staying valid for up to its normal
   * TTL during a Redis outage, exactly what happened before this feature
   * existed — for not taking down every authenticated route because a
   * supplementary check's backing store is unreachable.
   */
  async isRevoked(userId: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(`${KEY_PREFIX}${userId}`);
      return exists === 1;
    } catch (err) {
      this.logger.error(
        `Redis unavailable for revocation check on user ${userId} — failing open: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * A login challenge (email code or TOTP) is only rate-limited by the
   * per-IP throttle on POST /auth/login/verify by default — a distributed
   * attacker spreading guesses across many source IPs would otherwise get
   * unlimited tries against one challenge for its whole 10-minute validity.
   * This adds a real per-challenge cap independent of source IP: 5 wrong
   * attempts against the *same* challenge token and it's dead regardless of
   * where the next guess comes from. Keyed by a hash of the token (not the
   * raw token) so this value never itself becomes a way to reconstruct or
   * leak the challenge. Fails open on a Redis outage, consistent with this
   * service's other methods — a brief outage degrades back to IP-only
   * throttling rather than locking every in-flight login out.
   */
  async registerChallengeAttempt(
    challengeToken: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    try {
      const key = `${CHALLENGE_ATTEMPT_PREFIX}${createHash('sha256').update(challengeToken).digest('hex')}`;
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, ttlSeconds);
      }
      return count <= MAX_CHALLENGE_ATTEMPTS;
    } catch (err) {
      this.logger.error(
        `Redis unavailable for login-challenge attempt tracking — failing open: ${(err as Error).message}`,
      );
      return true;
    }
  }
}
