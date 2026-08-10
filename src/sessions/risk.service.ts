import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RiskAssessment {
  score: number;
  signals: Record<string, unknown>;
}

export interface AssessRiskInput {
  userId: string;
  isNewDevice: boolean;
  country: string | null;
  failedLoginCount: number;
}

/**
 * A simple, explainable point-based score computed once at login time —
 * not a machine-learning model, and deliberately not one. Every signal
 * here is something a human reviewing the audit log (or the admin flagged-
 * sessions view) can immediately understand and verify, which matters more
 * at this stage than marginal detection accuracy would.
 *
 * "Impossible travel" here is a country-plus-time-window heuristic, not a
 * geographic distance/speed calculation (haversine + a plausible max
 * flight speed). That richer version is a legitimate upgrade later; this
 * one needs no new infrastructure and already catches the common real
 * case (a stolen session token used from a different country shortly
 * after the legitimate login).
 */
@Injectable()
export class RiskService {
  private static readonly RECENT_SESSIONS_LOOKBACK = 5;
  private static readonly IMPOSSIBLE_TRAVEL_WINDOW_MS = 60 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  async assess(input: AssessRiskInput): Promise<RiskAssessment> {
    const signals: Record<string, unknown> = {};
    let score = 0;

    if (input.isNewDevice) {
      score += 30;
      signals.newDevice = true;
    }

    if (input.country) {
      const recentSessions = await this.prisma.session.findMany({
        where: { userId: input.userId },
        orderBy: { createdAt: 'desc' },
        take: RiskService.RECENT_SESSIONS_LOOKBACK,
        select: { country: true, createdAt: true },
      });

      if (recentSessions.length > 0) {
        const knownCountries = new Set(
          recentSessions
            .map((s) => s.country)
            .filter((c): c is string => c !== null),
        );
        if (knownCountries.size > 0 && !knownCountries.has(input.country)) {
          score += 25;
          signals.newCountry = {
            country: input.country,
            knownCountries: [...knownCountries],
          };
        }

        const mostRecent = recentSessions[0];
        const minutesSinceLastLogin =
          (Date.now() - mostRecent.createdAt.getTime()) / 60_000;
        if (
          mostRecent.country &&
          mostRecent.country !== input.country &&
          Date.now() - mostRecent.createdAt.getTime() <
            RiskService.IMPOSSIBLE_TRAVEL_WINDOW_MS
        ) {
          score += 50;
          signals.impossibleTravel = {
            fromCountry: mostRecent.country,
            toCountry: input.country,
            minutesSinceLastLogin: Math.round(minutesSinceLastLogin),
          };
        }
      }
    }

    if (input.failedLoginCount > 0) {
      score += Math.min(input.failedLoginCount * 5, 20);
      signals.recentFailedLogins = input.failedLoginCount;
    }

    return { score, signals };
  }
}
