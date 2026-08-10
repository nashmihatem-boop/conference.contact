import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { DEVICE_ID_COOKIE } from '../common/device/device-fingerprint.util';
import { TokenService } from '../common/tokens/token.service';
import { AuthService, RequestMeta, TokenPair } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { Confirm2faDto } from './dto/confirm-2fa.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { Disable2faDto } from './dto/disable-2fa.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyLoginDto } from './dto/verify-login.dto';
import type { AccessTokenPayload } from './types/jwt-payload.interface';

const REFRESH_COOKIE = 'cc_rt';
const REFRESH_COOKIE_PATH = '/api/v1/auth';
const DEVICE_ID_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const meta = this.buildMeta(req, res);
    return this.authService.register(dto, meta);
  }

  @Public()
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const meta = this.buildMeta(req, res);
    const result = await this.authService.login(dto, meta);
    if (!result.requiresVerification) {
      this.setRefreshCookie(
        res,
        result.refreshToken,
        result.refreshTokenExpiresAt,
      );
      return { accessToken: result.accessToken, requiresVerification: false };
    }
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login/verify')
  async verifyLogin(
    @Body() dto: VerifyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const meta = this.buildMeta(req, res);
    const result = await this.authService.verifyLogin(dto, meta);
    this.setRefreshCookie(
      res,
      result.refreshToken,
      result.refreshTokenExpiresAt,
    );
    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawRefreshToken = this.getCookie(req, REFRESH_COOKIE);
    if (!rawRefreshToken) {
      this.clearRefreshCookie(res);
      return { accessToken: null };
    }
    const meta = this.buildMeta(req, res);
    let result: TokenPair;
    try {
      result = await this.authService.refresh(rawRefreshToken, meta);
    } catch (err) {
      this.clearRefreshCookie(res);
      throw err;
    }
    this.setRefreshCookie(
      res,
      result.refreshToken,
      result.refreshTokenExpiresAt,
    );
    return { accessToken: result.accessToken };
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = this.getCookie(req, REFRESH_COOKIE);
    if (rawRefreshToken) {
      await this.authService.logout(rawRefreshToken);
    }
    this.clearRefreshCookie(res);
    return { message: 'Logged out' };
  }

  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: AccessTokenPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user.sub);
    this.clearRefreshCookie(res);
    return { message: 'Logged out on all devices' };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('2fa/enable')
  start2fa(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.start2fa(user.sub);
  }

  @Post('2fa/confirm')
  confirm2fa(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: Confirm2faDto,
  ) {
    return this.authService.confirm2fa(user.sub, dto.code);
  }

  @Post('2fa/disable')
  disable2fa(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: Disable2faDto,
  ) {
    return this.authService.disable2fa(user.sub, dto.password);
  }

  @Get('devices')
  listDevices(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.listDevices(user.sub);
  }

  @Post('devices/:id/trust')
  trustDevice(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id') deviceId: string,
  ) {
    return this.authService.trustDevice(user.sub, deviceId);
  }

  @Delete('devices/:id')
  removeDevice(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id') deviceId: string,
  ) {
    return this.authService.removeDevice(user.sub, deviceId);
  }

  @Get('sessions')
  listSessions(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.listSessions(user.sub);
  }

  // ── GDPR ─────────────────────────────────────────────────────────────

  @Get('data-export')
  exportData(@CurrentUser() user: AccessTokenPayload) {
    return this.authService.exportData(user.sub);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Delete('account')
  async deleteAccount(
    @CurrentUser() user: AccessTokenPayload,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.deleteAccount(user.sub, dto);
    this.clearRefreshCookie(res);
    return result;
  }

  // ── Cookie plumbing ──────────────────────────────────────────────────

  private buildMeta(req: Request, res: Response): RequestMeta {
    return {
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'],
      rawDeviceId: this.getOrCreateDeviceId(req, res),
    };
  }

  private getOrCreateDeviceId(req: Request, res: Response): string {
    const existing = this.getCookie(req, DEVICE_ID_COOKIE);
    if (existing) return existing;

    const fresh = this.tokens.generateOpaqueToken();
    res.cookie(DEVICE_ID_COOKIE, fresh, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'lax',
      maxAge: DEVICE_ID_MAX_AGE_MS,
      path: '/',
    });
    return fresh;
  }

  private setRefreshCookie(
    res: Response,
    token: string,
    expiresAt: Date,
  ): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.isProduction(),
      sameSite: 'strict',
      expires: expiresAt,
      path: REFRESH_COOKIE_PATH,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  private isProduction(): boolean {
    return this.config.get('NODE_ENV') === 'production';
  }

  /** `@types/cookie-parser` types `req.cookies` as `any` upstream — this centralizes the one cast needed to read a named cookie safely. */
  private getCookie(req: Request, name: string): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined;
    return cookies?.[name];
  }
}
