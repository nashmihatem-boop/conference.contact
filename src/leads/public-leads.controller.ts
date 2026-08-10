import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { AnonymousAiSearchDto } from './dto/anonymous-ai-search.dto';
import { PreviewLeadsQueryDto } from './dto/preview-leads-query.dto';
import { SelfSubmitLeadDto } from './dto/self-submit-lead.dto';
import { LeadsService } from './leads.service';

/**
 * No SubscriptionGuard applies here by construction (it's only ever
 * @UseGuards'd onto LeadsController) — this controller is for the routes
 * that are either fully public (the homepage preview, via @Public()) or
 * require sign-in but deliberately NOT a subscription (self-submit: being
 * found in the directory isn't a paid-search feature).
 */
@ApiTags('leads')
@Controller('leads')
export class PublicLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('preview')
  preview(@Query() query: PreviewLeadsQueryDto) {
    return this.leads.preview(query.search);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('self')
  submitSelf(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: SelfSubmitLeadDto,
  ) {
    return this.leads.submitSelf(user.sub, dto);
  }

  /** The real, current list of conferences in the dataset — powers the self-submit form's dropdown so a submission can never introduce a near-duplicate event name. */
  @Get('self/events')
  getEventOptions() {
    return this.leads.getFilters().then((filters) => filters.events);
  }

  /** Powers the "N free searches remaining" banner on the public AI Lead Finder page before a visitor has searched — read-only, doesn't count against the daily limit. */
  @Public()
  @Get('ai-search/anonymous/status')
  getAnonymousSearchStatus(@Req() req: Request) {
    return this.leads.getAnonymousSearchStatus(req.ip ?? 'unknown');
  }

  /**
   * The real thing: an unauthenticated visitor gets one live, real AI Lead
   * Finder search — same Claude + Apollo pipeline the paying product uses,
   * genuinely enriched, not a mocked/blurred teaser. The per-minute
   * @Throttle here is a coarse burst guard; the actual daily allowance is
   * enforced by LeadsService.anonymousSearch's own per-IP Redis counter,
   * which is what returns the "come back tomorrow" message once it's used.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('ai-search/anonymous')
  anonymousAiSearch(@Req() req: Request, @Body() dto: AnonymousAiSearchDto) {
    return this.leads.anonymousSearch(req.ip ?? 'unknown', dto.query);
  }
}
