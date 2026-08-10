import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const MATCH_URL = 'https://api.apollo.io/api/v1/people/match';

/** Bounds how long a hung/slow Apollo call can hold a request open — without this, a stalled upstream call rides out fetch's default (no timeout at all). */
const REQUEST_TIMEOUT_MS = 20_000;

/** Upstream error bodies are attacker/vendor-controlled text — capped before it lands in a thrown Error message or a log line, so a large or malformed body can't bloat logs or an exception message. */
const MAX_LOGGED_ERROR_BODY = 500;

async function truncatedErrorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '<unreadable body>');
  return text.length > MAX_LOGGED_ERROR_BODY
    ? `${text.slice(0, MAX_LOGGED_ERROR_BODY)}…`
    : text;
}

export interface ApolloSearchFilters {
  keywords?: string;
  /**
   * Feeds Apollo's real `q_organization_keyword_tags` — the review panel
   * presents "Search Keywords" and "Target Industries" as two separate UI
   * groups for clarity, but both are the same underlying Apollo mechanism,
   * so both are merged into this one array before the request goes out.
   */
  organizationKeywordTags?: string[];
  /** `q_not_organization_keyword_tags` — real, verified against the live API (differential-tested: excluding a tag measurably shrinks total_entries). */
  excludeOrganizationKeywordTags?: string[];
  personTitles?: string[];
  /** `person_seniorities` — real, Apollo-documented enum: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern. */
  personSeniorities?: string[];
  /**
   * `person_functions` — real but undocumented in Apollo's public API
   * reference; confirmed by differential-testing dozens of candidate slugs
   * against the live API. Only include values already verified this way
   * (see leads.service.ts's DEPARTMENT_FUNCTION_MAP) — an unrecognized
   * value here doesn't get ignored, it zeroes the whole result set.
   */
  personFunctions?: string[];
  personLocations?: string[];
  organizationLocations?: string[];
  /** `organization_num_employees_ranges`, format "min,max" e.g. "1,10" — real, differential-verified. */
  organizationNumEmployeesRanges?: string[];
  /** `revenue_range` — real, differential-verified (NOT `organization_revenue_range`, which Apollo silently ignores). */
  revenueMin?: number;
  revenueMax?: number;
  /** Set only for a direct lookup of one specific named person — see ClaudeService.parseApolloQuery. */
  personName?: string;
  personOrganization?: string;
}

export interface ApolloCandidate {
  apolloPersonId: string;
  name: string;
  title: string | null;
  company: string | null;
}

export interface ApolloEnrichedPerson {
  name: string | null;
  title: string | null;
  company: string | null;
  linkedin: string | null;
  email: string | null;
}

interface ApolloSearchPerson {
  id: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  organization?: { name?: string };
}

interface ApolloMatchPerson {
  name?: string;
  title?: string;
  organization?: { name?: string };
  organization_name?: string;
  linkedin_url?: string;
  email?: string;
}

/**
 * Thin wrapper around Apollo.io's REST API. Two calls, two different cost
 * profiles — that split isn't a design choice made here, it's how Apollo's
 * own API and billing are shaped:
 *  - People Search: cheap, paginated, returns masked candidates (obfuscated
 *    last name, no email/phone).
 *  - People Enrichment (aka "match"): one real Apollo credit per person,
 *    reveals the real name/email/LinkedIn — called once per candidate.
 */
@Injectable()
export class ApolloService {
  private readonly logger = new Logger(ApolloService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.getOrThrow<string>('APOLLO_API_KEY');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': this.apiKey,
    };
  }

  async searchPeople(
    filters: ApolloSearchFilters,
    perPage: number,
  ): Promise<ApolloCandidate[]> {
    const body: Record<string, unknown> = {
      page: 1,
      per_page: Math.min(perPage, 100),
    };
    if (filters.personTitles?.length) {
      body.person_titles = filters.personTitles;
      body.include_similar_titles = true;
    }
    if (filters.keywords) body.q_keywords = filters.keywords;
    if (filters.organizationKeywordTags?.length) {
      body.q_organization_keyword_tags = filters.organizationKeywordTags;
    }
    if (filters.excludeOrganizationKeywordTags?.length) {
      body.q_not_organization_keyword_tags =
        filters.excludeOrganizationKeywordTags;
    }
    if (filters.personSeniorities?.length) {
      body.person_seniorities = filters.personSeniorities;
    }
    if (filters.personFunctions?.length) {
      body.person_functions = filters.personFunctions;
    }
    if (filters.personLocations?.length) {
      body.person_locations = filters.personLocations;
    }
    if (filters.organizationLocations?.length) {
      body.organization_locations = filters.organizationLocations;
    }
    if (filters.organizationNumEmployeesRanges?.length) {
      body.organization_num_employees_ranges =
        filters.organizationNumEmployeesRanges;
    }
    if (filters.revenueMin != null || filters.revenueMax != null) {
      body.revenue_range = {
        ...(filters.revenueMin != null && { min: filters.revenueMin }),
        ...(filters.revenueMax != null && { max: filters.revenueMax }),
      };
    }

    const response = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Apollo people search failed (${response.status}): ${await truncatedErrorText(response)}`,
      );
    }

    let data: { people?: ApolloSearchPerson[] };
    try {
      data = (await response.json()) as { people?: ApolloSearchPerson[] };
    } catch {
      throw new Error('Apollo people search returned a malformed response');
    }
    return (data.people ?? []).map((person) => ({
      apolloPersonId: person.id,
      name:
        [person.first_name, person.last_name_obfuscated]
          .filter(Boolean)
          .join(' ') || 'Unknown',
      title: person.title ?? null,
      company: person.organization?.name ?? null,
    }));
  }

  /** Returns null on any failure — the caller marks that candidate "failed" without spending quota. */
  async enrichPerson(
    apolloPersonId: string,
  ): Promise<ApolloEnrichedPerson | null> {
    return this.match({ id: apolloPersonId }, apolloPersonId);
  }

  /**
   * Direct lookup of one specific named person — same /people/match
   * endpoint and cost (1 credit, 0 if nothing found) as enrichPerson, but
   * identified by name instead of an Apollo person id from a prior search.
   * Used for the Lead Finder's "I know exactly who I'm looking for" path,
   * distinct from the search-many-candidates flow.
   */
  async matchByName(
    name: string,
    organizationName?: string,
  ): Promise<ApolloEnrichedPerson | null> {
    return this.match({ name, organization_name: organizationName }, name);
  }

  private async match(
    body: Record<string, unknown>,
    logLabel: string,
  ): Promise<ApolloEnrichedPerson | null> {
    let response: Response;
    try {
      response = await fetch(MATCH_URL, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(
        `Apollo match request failed for ${logLabel}: ${(err as Error).message}`,
      );
      return null;
    }
    if (!response.ok) {
      this.logger.warn(
        `Apollo match failed for ${logLabel} (${response.status}): ${await truncatedErrorText(response)}`,
      );
      return null;
    }

    let data: { person?: ApolloMatchPerson };
    try {
      data = (await response.json()) as { person?: ApolloMatchPerson };
    } catch {
      this.logger.warn(
        `Apollo match returned a malformed response for ${logLabel}`,
      );
      return null;
    }
    const person = data.person;
    if (!person) return null;

    // A locked-email placeholder means "found nothing to reveal" — Apollo
    // itself documents this as a 0-credit outcome, not a failure of the call.
    const email =
      person.email && !person.email.includes('not_unlocked')
        ? person.email
        : null;

    return {
      name: person.name ?? null,
      title: person.title ?? null,
      company: person.organization?.name ?? person.organization_name ?? null,
      linkedin: person.linkedin_url ?? null,
      email,
    };
  }
}
