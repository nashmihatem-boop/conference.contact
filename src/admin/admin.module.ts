import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [SessionsModule, AuditModule, AuthModule, EmailModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
