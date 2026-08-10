import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { TokenRevocationService } from '../../common/token-revocation/token-revocation.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AccessTokenPayload } from '../types/jwt-payload.interface';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly revocation: TokenRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Reject anything that isn't specifically an access token — a
    // login-challenge or password-reset token, even if validly signed,
    // must never authenticate a request.
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    // One Redis round-trip closes the gap a purely stateless JWT otherwise
    // leaves: admin suspension (TokenRevocationService.revokeUser) writes
    // here, so a token minted seconds before someone was suspended stops
    // working immediately instead of riding out its full remaining TTL.
    if (await this.revocation.isRevoked(payload.sub)) {
      throw new UnauthorizedException('Access has been revoked');
    }

    (request as Request & { user: AccessTokenPayload }).user = payload;
    return true;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length);
  }
}
