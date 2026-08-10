import { createHash } from 'crypto';
import { UAParser } from 'ua-parser-js';

export interface DeviceDescriptor {
  browserName: string | null;
  browserVersion: string | null;
  os: string | null;
  deviceType: string | null;
}

/**
 * Device identity vs. device description are handled separately on purpose:
 *
 * - IDENTITY (the fingerprint) comes from a persistent, first-party random
 *   ID issued via cookie on first contact (see DEVICE_ID_COOKIE below). This
 *   is the cheap-but-real version — it survives IP changes and UA string
 *   quirks, and correctly treats "same browser, cookie cleared" as a new
 *   device, which is honest (from the server's perspective, it IS unrecog-
 *   nized again). Swapping in stronger client-side fingerprinting (canvas/
 *   audio signals via a library like FingerprintJS) later is a frontend
 *   change only — it just feeds a different value into the same field.
 *
 * - DESCRIPTION (browser/OS/device type) comes from parsing the User-Agent
 *   header, purely for human-readable display ("Chrome on Windows") in the
 *   devices/sessions list. It is never used to derive identity.
 */
export const DEVICE_ID_COOKIE = 'ccdid';

export function describeUserAgent(
  userAgent: string | undefined,
): DeviceDescriptor {
  if (!userAgent) {
    return {
      browserName: null,
      browserVersion: null,
      os: null,
      deviceType: null,
    };
  }
  const parsed = UAParser(userAgent);
  return {
    browserName: parsed.browser.name ?? null,
    browserVersion: parsed.browser.version ?? null,
    os: parsed.os.name ?? null,
    deviceType: parsed.device.type ?? 'desktop',
  };
}

export function hashDeviceId(rawDeviceId: string): string {
  return createHash('sha256').update(rawDeviceId).digest('hex');
}
