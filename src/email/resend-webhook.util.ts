import { createHmac, timingSafeEqual } from 'node:crypto';

// Resend signs webhooks using Svix's scheme (whsec_<base64>), not raw HMAC
// over the body — no new dependency added here (the codebase already
// avoids SDKs where a handful of crypto calls suffice, see ApolloService)
// since the algorithm is simple and well-documented: sign
// `${id}.${timestamp}.${body}` with the base64-decoded secret, compare
// against the space-separated `v1,<sig>` entries in svix-signature.
const TOLERANCE_SECONDS = 5 * 60;

export function verifyResendWebhookSignature(
  rawBody: string,
  headers: { svixId?: string; svixTimestamp?: string; svixSignature?: string },
  secret: string,
): boolean {
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestampSeconds = Number(svixTimestamp);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > TOLERANCE_SECONDS
  ) {
    return false;
  }

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);

  return svixSignature.split(' ').some((entry) => {
    const [, sig] = entry.split(',');
    if (!sig) return false;
    const sigBuf = Buffer.from(sig);
    return (
      sigBuf.length === expectedBuf.length &&
      timingSafeEqual(sigBuf, expectedBuf)
    );
  });
}
