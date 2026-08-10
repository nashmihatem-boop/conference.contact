import { Injectable } from '@nestjs/common';
import type * as runtime from '@prisma/client/runtime/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: runtime.InputJsonValue;
  ipAddress?: string | null;
}

/**
 * The only way application code should ever touch the audit_logs table.
 * Rows are append-only by convention — nothing in this service exposes an
 * update or delete, deliberately.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }
}
