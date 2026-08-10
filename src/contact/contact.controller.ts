import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { ContactService } from './contact.service';
import { ContactDto } from './dto/contact.dto';

/**
 * Public — anyone reaches this without being signed in, deliberately
 * (a suspended user can't sign in at all, and that's exactly who most
 * needs this route). Throttled tighter than the global default since it's
 * unauthenticated and triggers a real outbound email per request.
 */
@ApiTags('contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  submit(@Body() dto: ContactDto): Promise<{ message: string }> {
    return this.contact.submit(dto);
  }
}
