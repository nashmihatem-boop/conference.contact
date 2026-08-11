import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Unsubscribe links have to keep working indefinitely for an email address
 * that may never have (or never will have) a User row — so unlike every
 * other secret-bearing link in this app (see TokenService), there's no
 * account to attach a stored, hashed, single-use token to. A stateless
 * HMAC signature over the email is the standard pattern for exactly this
 * case (same approach virtually every ESP uses for list-unsubscribe
 * links): nothing to store, nothing to expire, and it can't be forged
 * without UNSUBSCRIBE_SECRET.
 */
export function signUnsubscribeToken(email: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(email.trim().toLowerCase())
    .digest('base64url');
}

export function verifyUnsubscribeToken(
  email: string,
  token: string,
  secret: string,
): boolean {
  const expected = signUnsubscribeToken(email, secret);
  const expectedBuf = Buffer.from(expected);
  const tokenBuf = Buffer.from(token);
  return (
    expectedBuf.length === tokenBuf.length &&
    timingSafeEqual(expectedBuf, tokenBuf)
  );
}
