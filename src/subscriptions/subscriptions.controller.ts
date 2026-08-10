import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { CreateCreditsCheckoutDto } from './dto/create-credits-checkout.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Public()
  @Get('plans')
  listPlans() {
    return this.subscriptions.listPlans();
  }

  @Post('checkout')
  createCheckout(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.subscriptions.createCheckoutSession(user.sub, dto.planSlug);
  }

  @Post('portal')
  createPortal(@CurrentUser() user: AccessTokenPayload) {
    return this.subscriptions.createPortalSession(user.sub);
  }

  @Get('status')
  status(@CurrentUser() user: AccessTokenPayload) {
    return this.subscriptions.getStatus(user.sub);
  }

  @Post('cancel')
  cancel(@CurrentUser() user: AccessTokenPayload) {
    return this.subscriptions.cancel(user.sub);
  }

  @Public()
  @Get('credit-packs')
  listCreditPacks() {
    return this.subscriptions.listCreditPacks();
  }

  @Post('credits/checkout')
  createCreditsCheckout(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateCreditsCheckoutDto,
  ) {
    return this.subscriptions.createCreditsCheckoutSession(
      user.sub,
      dto.packSlug,
      dto.quantity,
    );
  }
}
