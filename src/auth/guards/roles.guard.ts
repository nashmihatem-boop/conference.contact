import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Role } from '../../../generated/prisma/enums';
import { AccessTokenPayload } from '../types/jwt-payload.interface';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Runs after JwtAuthGuard (global) has already attached `request.user`.
 * Route-level, not global — applied explicitly wherever a `@Roles(...)`
 * boundary is needed, the same way SubscriptionGuard is applied per-route
 * rather than app-wide.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AccessTokenPayload }>();
    if (!request.user) {
      // Should be unreachable in practice — JwtAuthGuard runs first and
      // rejects unauthenticated requests before this guard ever sees them.
      // Kept as defense in depth, not as the primary auth check.
      throw new UnauthorizedException();
    }

    if (!required.includes(request.user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
