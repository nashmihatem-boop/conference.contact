import { Global, Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { EncryptionService } from './encryption/encryption.service';
import { GeoipService } from './geoip/geoip.service';
import { TokenRevocationService } from './token-revocation/token-revocation.service';
import { TokenService } from './tokens/token.service';

/**
 * Generic, stateless utility services with no feature-specific dependencies
 * of their own — except TokenRevocationService, which needs REDIS_CLIENT
 * from QueueModule. @Global so any module can inject any of these without
 * needing to import this module explicitly — matches how PrismaModule is
 * wired.
 */
@Global()
@Module({
  imports: [QueueModule],
  providers: [
    TokenService,
    EncryptionService,
    GeoipService,
    TokenRevocationService,
  ],
  exports: [
    TokenService,
    EncryptionService,
    GeoipService,
    TokenRevocationService,
  ],
})
export class CommonModule {}
