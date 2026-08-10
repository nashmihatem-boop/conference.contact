import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PERSON_SENIORITIES } from './apollo-taxonomy';

/**
 * What the review-parameters panel shows and lets the user edit before
 * running a real search. Deliberately narrower than the full Apollo filter
 * set AiSearchDto accepts — Claude only fills in what a natural-language
 * query can actually imply. Numeric ranges (company size, revenue) and the
 * department/function picker are left for the user to set explicitly in the
 * panel: company size/revenue aren't reliably inferable from prose, and
 * person_functions fails closed on any unrecognized value (see
 * apollo-taxonomy.ts), so guessing one from free text risks silently
 * zeroing real results instead of just not narrowing them.
 */
export interface ParsedSearchFilters {
  campaignName: string;
  searchKeywords: string[];
  targetIndustries: string[];
  personTitles: string[];
  personSeniorities: string[];
  location: string;
  personName: string;
  personOrganization: string;
}

const EXTRACT_APOLLO_FILTERS_TOOL: Anthropic.Tool = {
  name: 'extract_apollo_filters',
  description:
    'Extracts Apollo.io People Search filters from a natural-language lead-finding query.',
  input_schema: {
    type: 'object',
    properties: {
      campaignName: {
        type: 'string',
        description:
          'A short (3-6 word) descriptive label for this search, e.g. "Healthcare CTOs in Boston". Always populate this — it prefills an editable "Campaign Name" field.',
      },
      searchKeywords: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Short keyword/phrase tags (2-4 words each) describing specific, concrete things about the target companies — technologies used, funding events, products, business model (e.g. "using React", "raised Series A", "B2B marketplace"). Never put a literal private company or person name here: it will not appear as a keyword in Apollo\'s index. If the query names a specific company as a reference point (e.g. "competitors of Acme"), use general knowledge to describe that company\'s real market/product space here instead of its name.',
      },
      targetIndustries: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Broad industry/vertical category tags for the target companies (e.g. "healthcare", "fintech", "SaaS", "affiliate marketing"), distinct from searchKeywords which are more specific descriptors. Leave empty if the query does not imply a specific industry.',
      },
      personTitles: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Job titles to search for — combine any explicitly given target titles with ones implied by the query.',
      },
      personSeniorities: {
        type: 'array',
        items: { type: 'string', enum: [...PERSON_SENIORITIES] },
        description: `Seniority levels implied by the query, chosen ONLY from this exact set: ${PERSON_SENIORITIES.join(', ')}. E.g. "CMOs" implies c_suite, "VP of Marketing" implies vp. Leave empty if no seniority is implied — do not guess.`,
      },
      location: {
        type: 'string',
        description:
          "Target companies' location (city/region/country), only if the query specifies one.",
      },
      personName: {
        type: 'string',
        description:
          'The full name of one specific real person, populated ONLY when the query is a direct lookup for that individual (e.g. a bare name, "find contact info for Jane Doe", "who is John Smith at Acme"). When this is set, every other field except campaignName must be left empty — this is a direct 1-credit lookup, not a criteria search, and takes a completely different code path.',
      },
      personOrganization: {
        type: 'string',
        description:
          "That person's company, only if personName is set and a company was given or is unambiguous from context.",
      },
    },
    required: ['campaignName'],
  },
};

/**
 * Wraps Claude's tool-use (forced function-calling) so Lead Finder's
 * natural-language query is guaranteed to come back as structured JSON,
 * ready to prefill the review-parameters panel — not free text to regex
 * out. This is a preview step only: see LeadsService.parseQuery. The actual
 * search (LeadsService.aiSearch / ApolloSearchProcessor) runs on whatever
 * structured filters the user confirms in that panel, not on a fresh call
 * to Claude — so an edit the user makes always wins over Claude's guess.
 */
@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY'),
      // The SDK's own default (10 minutes) is far too long for a request a
      // user is actively waiting on — this is a single tool-use call, not a
      // long-running generation. Bounds how long a slow/hung Claude call
      // can hold the request open; callers (LeadsService.anonymousSearch,
      // .parseQuery) turn the resulting timeout error into a clear
      // user-facing message rather than a bare 500.
      timeout: 20_000,
    });
  }

  /**
   * Two distinct intents share this one free-text box, and Claude is what
   * disambiguates them (a regex/heuristic on "looks like a name" would be
   * both wrong and unmaintainable):
   *  - "Find people LIKE this company/person" (e.g. "marketing directors at
   *    competitors of Evercontractor") → keyword/title criteria search,
   *    the original behavior. A bare company or person name with no other
   *    context defaults here too, since that's the more common intent for
   *    an exploratory query.
   *  - "Find THIS exact person" (e.g. "find contact info for Jane Doe",
   *    "who is John Smith at Acme") → personName (+ personOrganization),
   *    a direct 1-credit Apollo match instead of a search. The system
   *    prompt requires every other field be left empty in this case so
   *    the frontend/processor can branch on personName alone.
   */
  async parseApolloQuery(
    query: string,
    jobTitles?: string[],
  ): Promise<ParsedSearchFilters> {
    const userContent = jobTitles?.length
      ? `${query}\n\nTarget job titles: ${jobTitles.join(', ')}`
      : query;

    const message = await this.client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system:
        'You translate a lead-finding request into Apollo.io People Search filters. Two intents are possible: (1) the query explicitly asks to look up or find contact info for ONE specific real named person (e.g. "find contact info for Jane Doe", "who is John Smith at Acme", or a query giving a full name plus their company) — in this case populate ONLY campaignName + personName (and personOrganization if given), leave every other field empty, and do not infer competitors. (2) anything else, including a bare company or person name with no explicit "look this person up" intent, or a request to find people LIKE a company/competitor — treat it as a criteria search: use your general knowledge to identify what industry or market that company operates in and who its real-world competitors are, then produce searchKeywords/targetIndustries describing that competitive space (never search for the literal company or person name itself, since Apollo\'s index won\'t match on a private company\'s own name), and combine any explicitly given target job titles with ones implied by the query.',
      messages: [{ role: 'user', content: userContent }],
      tools: [EXTRACT_APOLLO_FILTERS_TOOL],
      tool_choice: { type: 'tool', name: 'extract_apollo_filters' },
    });

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUse) {
      this.logger.warn(
        `Claude response had no tool_use block for Apollo query parsing — falling back to the raw query as the campaign name. stop_reason: ${message.stop_reason}`,
      );
      return {
        campaignName: query.slice(0, 200),
        searchKeywords: [],
        targetIndustries: [],
        personTitles: jobTitles ?? [],
        personSeniorities: [],
        location: '',
        personName: '',
        personOrganization: '',
      };
    }

    const input = toolUse.input as Partial<ParsedSearchFilters>;
    return {
      campaignName: input.campaignName || query.slice(0, 200),
      searchKeywords: input.searchKeywords ?? [],
      targetIndustries: input.targetIndustries ?? [],
      personTitles: input.personTitles?.length
        ? input.personTitles
        : (jobTitles ?? []),
      personSeniorities: input.personSeniorities ?? [],
      location: input.location ?? '',
      personName: input.personName ?? '',
      personOrganization: input.personOrganization ?? '',
    };
  }
}
