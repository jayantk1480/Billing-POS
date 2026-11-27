import { Global, Injectable, Module } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import type { AuthContext } from '../../common/auth/auth-context.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

type Actor = Pick<AuthContext, 'restaurantId'> & Partial<Pick<AuthContext, 'userId' | 'terminalId' | 'ip'>>;

const SECRET_FIELDS = new Set(['passwordHash', 'pinHash', 'password', 'pin', 'refreshTokenHash', 'tokenHash']);

/** Removes secrets and makes a value safe to store as JSON. */
function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, inner) => (SECRET_FIELDS.has(key) ? undefined : inner)),
  ) as Prisma.InputJsonValue;
}

/** Writes the append-only audit trail. Pass `tx` to record inside the caller's transaction. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(actor: Actor, entry: AuditEntry, tx: Prisma.TransactionClient | PrismaClient = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        restaurantId: actor.restaurantId,
        userId: actor.userId ?? null,
        terminalId: actor.terminalId ?? null,
        ip: actor.ip ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: sanitize(entry.before),
        after: sanitize(entry.after),
        reason: entry.reason ?? null,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
