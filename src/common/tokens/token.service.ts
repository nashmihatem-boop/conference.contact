import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';

/**
 * Every secret-bearing token in this app (refresh tokens, email
 * verification tokens, password reset tokens) follows the same pattern:
 * generate a high-entropy random value, hand the RAW value to the user
 * exactly once, and only ever persist its SHA-256 hash. A stolen database
 * dump then contains nothing usable — hashes can't be replayed.
 */
@Injectable()
export class TokenService {
  /** 256 bits of entropy, URL-safe. Used for refresh tokens and one-time links. */
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** 6-digit numeric code for email-based new-device / login verification. */
  generateNumericCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
