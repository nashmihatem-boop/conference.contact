import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    SessionsModule,
    EmailModule,
    AuditModule,
    BillingModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Registered here (rather than AppModule) because it depends on
    // JwtService, which this module owns. @Global-style APP_GUARD
    // providers resolve fine from any module — this just keeps the
    // dependency graph honest about where JwtService actually lives.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // AdminModule needs AuthService.signImpersonationToken for the
  // admin "view as this user" feature.
  exports: [AuthService],
})
export class AuthModule {}
