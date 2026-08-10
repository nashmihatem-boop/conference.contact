import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AccessTokenPayload } from '../auth/types/jwt-payload.interface';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InvitesService } from './invites.service';

/** Every route here requires a signed-in user — JwtAuthGuard (global) covers that; no SubscriptionGuard, since inviting a colleague isn't a paid-plan feature. */
@ApiTags('invites')
@Controller('invites')
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  list(@CurrentUser() user: AccessTokenPayload) {
    return this.invites.listInvites(user.sub);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invites.createInvite(user.sub, dto.email);
  }
}
