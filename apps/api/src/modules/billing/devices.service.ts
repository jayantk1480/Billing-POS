import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@pos/database';
import type { DeviceNumbersDto, PosDeviceDto, registerDeviceSchema } from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { BillingContextService, type Db } from './billing-context.js';

/**
 * Where a device's own series stand on the server: the next bill number for this financial year and the next order
 * number for today's period. A device that lost its storage carries on from here instead of reusing numbers.
 */
export async function deviceNumbers(
  db: Db, context: BillingContextService, device: { restaurantId: string; offlineTerminalId: string; offlineTerminal: { code: string } },
): Promise<DeviceNumbersDto> {
  const ctx = await context.load(device.restaurantId, db);
  const code = device.offlineTerminal.code;
  const [series, last] = await Promise.all([
    db.numberSeries.findUnique({ where: { terminalId_type_financialYear: { terminalId: device.offlineTerminalId, type: 'INVOICE', financialYear: ctx.financialYear } } }),
    db.order.aggregate({ where: { restaurantId: device.restaurantId, series: code, numberPeriod: ctx.numberPeriod }, _max: { orderNumber: true } }),
  ]);
  return {
    offlineCode: code, financialYear: ctx.financialYear, nextInvoiceNumber: series?.nextNumber ?? 1,
    numberPeriod: ctx.numberPeriod, nextOrderNumber: (last._max.orderNumber ?? 0) + 1,
  };
}

/** Offline till codes are Z and two of these: no O or I, which read as 0 and 1 on paper. */
const CODE_CHARACTERS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** The first free offline till code: Z01, Z02 … ZZZ. */
function nextFreeCode(taken: Set<string>): string | null {
  for (let index = 1; index < CODE_CHARACTERS.length ** 2; index += 1) {
    const code = 'Z' + CODE_CHARACTERS[Math.floor(index / CODE_CHARACTERS.length)] + CODE_CHARACTERS[index % CODE_CHARACTERS.length];
    if (!taken.has(code)) return code;
  }
  return null;
}

/**
 * The devices the POS runs on. Each is given a hidden till of its own (kind OFFLINE) the first time it registers,
 * whose order and bill series only that device uses: the bills it makes while the internet is down can then be
 * numbered on the device without ever colliding with another's.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly context: BillingContextService,
  ) {}

  async register(auth: AuthContext, input: z.output<typeof registerDeviceSchema>): Promise<PosDeviceDto> {
    const { device, created } = await this.prisma.$transaction(async (tx) => {
      // One registration at a time per restaurant, so two new devices never take the same code.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'pos-device:' + auth.restaurantId}, 0))`;
      const include = { offlineTerminal: { select: { code: true } } } as const;
      const known = await tx.posDevice.findUnique({
        where: { restaurantId_deviceKey: { restaurantId: auth.restaurantId, deviceKey: input.deviceKey } }, include,
      });
      if (known) {
        if (known.revokedAt) throw conflict('DEVICE_REVOKED', 'This device was removed from the restaurant. Ask the owner to add it again.');
        const device = await tx.posDevice.update({
          where: { id: known.id }, include,
          data: { lastSeenAt: new Date(), homeTerminalId: auth.terminalId ?? known.homeTerminalId, label: input.label ?? known.label },
        });
        return { device, created: false };
      }
      const taken = new Set(
        (await tx.terminal.findMany({ where: { restaurantId: auth.restaurantId, code: { startsWith: 'Z' } }, select: { code: true } })).map((t) => t.code),
      );
      const code = nextFreeCode(taken);
      if (!code) throw conflict('DEVICE_LIMIT', 'Every offline till code is in use. Remove devices that are no longer used.');
      const till = await tx.terminal.create({ data: { restaurantId: auth.restaurantId, code, name: 'Offline ' + code, kind: 'OFFLINE' } });
      const device = await tx.posDevice.create({
        include,
        data: { restaurantId: auth.restaurantId, deviceKey: input.deviceKey, offlineTerminalId: till.id, homeTerminalId: auth.terminalId, label: input.label ?? null },
      });
      return { device, created: true };
    });
    if (created) {
      await this.audit.record(auth, {
        action: 'device.registered', entityType: 'device', entityId: device.id, after: { offlineCode: device.offlineTerminal.code, label: device.label },
      });
    }
    return {
      id: device.id, offlineCode: device.offlineTerminal.code, registeredAt: device.createdAt.toISOString(),
      numbers: await deviceNumbers(this.prisma, this.context, device),
    };
  }
}
