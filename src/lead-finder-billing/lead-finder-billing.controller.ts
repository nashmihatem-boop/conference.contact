import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { CreateLeadFinderCheckoutDto } from './dto/create-lead-finder-checkout.dto';
import { LeadFinderBillingService } from './lead-finder-billing.service';

@ApiTags('lead-finder-billing')
@Controller('lead-finder')
export class LeadFinderBillingController {
  constructor(private readonly billing: LeadFinderBillingService) {}

  @Public()
  @Get('tiers')
  listTiers() {
    return this.billing.listTiers();
  }

  @Get('status')
  status(@CurrentUser() user: AccessTokenPayload) {
    return this.billing.getStatus(user.sub);
  }

  @Post('checkout')
  createCheckout(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateLeadFinderCheckoutDto,
  ) {
    return this.billing.createCheckoutSession(user.sub, dto.tierSlug);
  }

  @Post('cancel')
  cancel(@CurrentUser() user: AccessTokenPayload) {
    return this.billing.cancel(user.sub);
  }
}
