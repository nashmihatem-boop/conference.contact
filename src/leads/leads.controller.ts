import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { DirectoryAccessGuard } from '../subscriptions/guards/directory-access.guard';
import { AiSearchDto } from './dto/ai-search.dto';
import { ExportLeadsQueryDto } from './dto/export-leads-query.dto';
import { GetMoreLeadsDto } from './dto/get-more-leads.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { ParseQueryDto } from './dto/parse-query.dto';
import { SuggestQueryDto } from './dto/suggest-query.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';
import { LeadsService } from './leads.service';

/**
 * Two different gates on one controller, not a uniform one — the Lead
 * Directory (list/filters/export) stays unlocked forever once you've paid
 * and cancelled on your own terms (DirectoryAccessGuard). The AI Lead
 * Finder (everything else here) has no subscription gate at all — every
 * signed-in user (JwtAuthGuard, global) starts on the Free tier's credits
 * and is gated purely by their credit balance, checked inside
 * LeadsService.aiSearch — matching how the reference product's own Free
 * tier works standalone, no payment required.
 */
@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @UseGuards(DirectoryAccessGuard)
  @Get()
  list(@Query() query: ListLeadsQueryDto) {
    return this.leads.list(query);
  }

  @UseGuards(DirectoryAccessGuard)
  @Get('filters')
  getFilters() {
    return this.leads.getFilters();
  }

  @UseGuards(DirectoryAccessGuard)
  @Get('export')
  async export(
    @Query() query: ExportLeadsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.leads.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  }

  @Get('credits')
  getCredits(@CurrentUser() user: AccessTokenPayload) {
    return this.leads.getCredits(user.sub);
  }

  /** Preview only — turns a free-text query into structured filters for the review panel. No job, no credits spent. */
  @Post('parse-query')
  parseQuery(@Body() dto: ParseQueryDto) {
    return this.leads.parseQuery(dto);
  }

  /** Static reference data (seniorities, company size ranges, revenue buckets, department taxonomy) for the review panel. */
  @Get('taxonomy')
  getTaxonomy() {
    return this.leads.getTaxonomy();
  }

  /** Typeahead for the review panel's tag inputs, backed by real Lead Directory data (Apollo has no public autocomplete API). */
  @Get('suggest')
  suggest(@Query() dto: SuggestQueryDto) {
    return this.leads.suggest(dto);
  }

  @Post('ai-search')
  aiSearch(@CurrentUser() user: AccessTokenPayload, @Body() dto: AiSearchDto) {
    return this.leads.aiSearch(user.sub, dto);
  }

  // Must precede the :jobId route below — otherwise "history" would be
  // matched as a jobId.
  @Get('ai-search/history')
  getHistory(@CurrentUser() user: AccessTokenPayload) {
    return this.leads.listSearchHistory(user.sub);
  }

  @Get('ai-search/:jobId')
  getSearchJob(
    @CurrentUser() user: AccessTokenPayload,
    @Param('jobId') jobId: string,
  ) {
    return this.leads.getSearchJob(user.sub, jobId);
  }

  @Post('ai-search/:jobId/cancel')
  cancelSearchJob(
    @CurrentUser() user: AccessTokenPayload,
    @Param('jobId') jobId: string,
  ) {
    return this.leads.cancelSearchJob(user.sub, jobId);
  }

  @Post('ai-search/:jobId/more')
  getMoreLeads(
    @CurrentUser() user: AccessTokenPayload,
    @Param('jobId') jobId: string,
    @Body() dto: GetMoreLeadsDto,
  ) {
    return this.leads.getMoreLeads(user.sub, jobId, dto);
  }

  @Patch('ai-search/:jobId/results/:resultId')
  updateResultReviewStatus(
    @CurrentUser() user: AccessTokenPayload,
    @Param('jobId') jobId: string,
    @Param('resultId') resultId: string,
    @Body() dto: UpdateReviewStatusDto,
  ) {
    return this.leads.updateResultReviewStatus(user.sub, jobId, resultId, dto);
  }
}
