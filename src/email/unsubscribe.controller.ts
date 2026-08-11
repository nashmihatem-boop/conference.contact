import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { verifyUnsubscribeToken } from './unsubscribe-token.util';
import { UnsubscribeDto } from './dto/unsubscribe.dto';

/**
 * Public, unauthenticated — an unsubscribe link has to work for someone who
 * has never signed up and never will (see AdminService.inviteProspect). The
 * token itself (verifyUnsubscribeToken) is what proves the request is
 * genuine, not a session; anyone who has a valid link for an email can
 * suppress that email, which is the same trust model every ESP's
 * one-click-unsubscribe link uses.
 */
@ApiTags('unsubscribe')
@Controller('unsubscribe')
export class UnsubscribeController {
  private readonly unsubscribeSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.unsubscribeSecret =
      this.config.getOrThrow<string>('UNSUBSCRIBE_SECRET');
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async unsubscribe(@Body() dto: UnsubscribeDto): Promise<{ message: string }> {
    const email = dto.email.trim().toLowerCase();
    if (!verifyUnsubscribeToken(email, dto.token, this.unsubscribeSecret)) {
      throw new BadRequestException('Invalid or expired unsubscribe link.');
    }

    // Upsert, not create: clicking an already-used link (a second time, or
    // via an email-scanner bot prefetch) must stay idempotent rather than
    // throwing on the unique constraint.
    await this.prisma.emailSuppression.upsert({
      where: { email },
      create: { email },
      update: {},
    });

    return { message: `${email} has been unsubscribed.` };
  }
}
