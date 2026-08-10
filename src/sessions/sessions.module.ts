import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { RiskService } from './risk.service';
import { SessionsService } from './sessions.service';

@Module({
  providers: [DevicesService, SessionsService, RiskService],
  exports: [DevicesService, SessionsService, RiskService],
})
export class SessionsModule {}
