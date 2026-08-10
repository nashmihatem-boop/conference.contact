import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  private readonly maxAttempts: number;
  private readonly lockoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.maxAttempts = this.config.get<number>('LOGIN_MAX_ATTEMPTS', 5);
    this.lockoutMinutes = this.config.get<number>('LOGIN_LOCKOUT_MINUTES', 15);
  }

  /** Every lookup/write goes through this — emails are case-insensitive by convention. */
  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  create(data: {
    email: string;
    fullName: string;
    passwordHash: string;
    phone?: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: this.normalizeEmail(data.email),
        fullName: data.fullName,
        passwordHash: data.passwordHash,
        phone: data.phone,
      },
    });
  }

  /** Email is deliberately not editable here — changing it would need its own re-verification flow, not a plain field update. */
  updateProfile(
    id: string,
    data: { fullName?: string; phone?: string },
  ): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  markEmailVerified(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { emailVerifiedAt: new Date() },
    });
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
  }

  updateLastLogin(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  isLocked(user: Pick<User, 'lockedUntil'>): boolean {
    return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
  }

  /**
   * Called on every failed password check. Once failedLoginCount reaches
   * the threshold, the account locks for `lockoutMinutes` and the counter
   * resets — a fresh lockout window starts if the attacker keeps trying
   * after it expires, rather than escalating indefinitely.
   */
  async registerFailedLogin(id: string): Promise<{ locked: boolean }> {
    const user = await this.prisma.user.update({
      where: { id },
      data: { failedLoginCount: { increment: 1 } },
    });

    if (user.failedLoginCount >= this.maxAttempts) {
      await this.prisma.user.update({
        where: { id },
        data: {
          failedLoginCount: 0,
          lockedUntil: new Date(Date.now() + this.lockoutMinutes * 60_000),
        },
      });
      return { locked: true };
    }
    return { locked: false };
  }

  async resetFailedLogins(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  async setTwoFactorSecret(id: string, encryptedSecret: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { twoFactorSecret: encryptedSecret },
    });
  }

  async enableTwoFactor(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { twoFactorEnabled: true },
    });
  }

  async disableTwoFactor(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
  }
}
