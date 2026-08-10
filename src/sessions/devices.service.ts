import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Device } from '../../generated/prisma/client';
import { DeviceDescriptor } from '../common/device/device-fingerprint.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DevicesService {
  private readonly maxTrustedDevices: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.maxTrustedDevices = this.config.get<number>('MAX_TRUSTED_DEVICES', 3);
  }

  /**
   * Looks up the device by (userId, fingerprint). Returns `isNew: true`
   * when this is the first time this fingerprint has been seen for this
   * user — the caller (AuthService) uses that to decide whether new-device
   * verification is required.
   */
  async findOrCreateDevice(
    userId: string,
    fingerprint: string,
    descriptor: DeviceDescriptor,
  ): Promise<{ device: Device; isNew: boolean }> {
    const existing = await this.prisma.device.findUnique({
      where: { userId_fingerprint: { userId, fingerprint } },
    });

    if (existing) {
      const device = await this.prisma.device.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      return { device, isNew: false };
    }

    const device = await this.prisma.device.create({
      data: {
        userId,
        fingerprint,
        browserName: descriptor.browserName,
        browserVersion: descriptor.browserVersion,
        os: descriptor.os,
        deviceType: descriptor.deviceType,
      },
    });
    return { device, isNew: true };
  }

  /** Excludes `fingerprint` — internal identity material with no reason to reach a client response. */
  listForUser(userId: string) {
    return this.prisma.device.findMany({
      where: { userId },
      select: {
        id: true,
        browserName: true,
        browserVersion: true,
        os: true,
        deviceType: true,
        isTrusted: true,
        trustedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  findById(id: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { id } });
  }

  /** Excludes `fingerprint` — same rationale as `listForUser()`, since this also returns straight to the client. */
  async trust(userId: string, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device || device.userId !== userId) {
      throw new NotFoundException('Device not found');
    }

    const trustedCount = await this.prisma.device.count({
      where: { userId, isTrusted: true },
    });
    if (trustedCount >= this.maxTrustedDevices) {
      throw new ForbiddenException(
        `You can have at most ${this.maxTrustedDevices} trusted devices. Remove one first.`,
      );
    }

    return this.prisma.device.update({
      where: { id: deviceId },
      data: { isTrusted: true, trustedAt: new Date() },
      select: {
        id: true,
        browserName: true,
        browserVersion: true,
        os: true,
        deviceType: true,
        isTrusted: true,
        trustedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    });
  }

  /**
   * Removing a device also revokes every session tied to it — trust and
   * active access are the same decision from the user's point of view
   * ("get this device off my account" should actually log it out).
   */
  async remove(userId: string, deviceId: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device || device.userId !== userId) {
      throw new NotFoundException('Device not found');
    }

    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      // Session.deviceId is onDelete: SetNull, so deleting the device never
      // orphans a session row — history is preserved, just unlinked.
      this.prisma.device.delete({ where: { id: deviceId } }),
    ]);
  }

  countTrusted(userId: string): Promise<number> {
    return this.prisma.device.count({ where: { userId, isTrusted: true } });
  }
}
