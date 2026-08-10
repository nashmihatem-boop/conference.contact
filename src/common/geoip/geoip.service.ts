import { Injectable } from '@nestjs/common';
import geoip from 'geoip-lite';

export interface GeoLocation {
  country: string;
  city: string | null;
  timezone: string | null;
}

/**
 * Offline IP geolocation via geoip-lite's bundled database — no account,
 * API key, or outbound request per lookup. Deliberately chosen over a live
 * third-party geolocation API: sending every user's real IP to an external
 * service on every login is a data-sharing decision with real privacy
 * implications that shouldn't be made silently, and a local lookup is also
 * faster and has no rate limit. Less fresh/precise than MaxMind's paid
 * GeoIP2, which is the natural upgrade path if city-level accuracy ever
 * matters more than it does for "which country did this login come from."
 */
@Injectable()
export class GeoipService {
  /** Null for loopback/private/unresolvable IPs — most local dev traffic, not an error case. */
  lookup(ipAddress: string | null): GeoLocation | null {
    if (!ipAddress) return null;
    const normalized =
      ipAddress === '::1' ? '127.0.0.1' : ipAddress.replace(/^::ffff:/, '');
    const result = geoip.lookup(normalized);
    if (!result) return null;
    return {
      country: result.country,
      city: result.city || null,
      timezone: result.timezone || null,
    };
  }
}
