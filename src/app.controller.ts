import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  /**
   * Public health check — infrastructure (load balancers, container
   * orchestrators, uptime monitors) needs to hit this without a token.
   * Everything else in the API is protected by default via the global
   * JwtAuthGuard, so this needs the explicit opt-out.
   */
  @Public()
  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
