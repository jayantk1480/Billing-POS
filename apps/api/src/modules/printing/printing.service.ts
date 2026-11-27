import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@pos/database';
import {
  type BridgeCreatedDto, type BridgeDto, type createBridgeSchema, kotLayoutSchema, type PrinterDto, type printerSchema, type PrintingStatusDto, type PrintLayoutsDto,
  receiptLayoutSchema, type updatePrinterSchema, type updatePrintLayoutsSchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';

const printerInclude = { stations: { select: { name: true }, orderBy: { name: 'asc' } } } as const;
type PrinterRow = Prisma.PrinterGetPayload<{ include: typeof printerInclude }>;

/** A bridge counts as online when it asked for work within this time. It asks every second or two. */
export const BRIDGE_ONLINE_MS = 30_000;
export const hashBridgeToken = (token: string) => createHash('sha256').update(token).digest('hex');

const LAYOUT_NAME = 'Default';

/** Printers, the layout of printouts, and the print bridges that reach the printers. */
@Injectable()
export class PrintingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  // ── Printers ──

  async listPrinters(auth: AuthContext): Promise<PrinterDto[]> {
    const printers = await this.prisma.printer.findMany({ where: { restaurantId: auth.restaurantId }, include: printerInclude, orderBy: [{ role: 'asc' }, { name: 'asc' }] });
    return printers.map(toPrinterDto);
  }

  async createPrinter(auth: AuthContext, input: z.output<typeof printerSchema>): Promise<PrinterDto> {
    await this.assertUniqueName(auth, input.name);
    const printer = await this.prisma.$transaction(async (tx) => {
      // The first printer for a role is its default; choosing a new default replaces the old one.
      const first = (await tx.printer.count({ where: { restaurantId: auth.restaurantId, role: input.role } })) === 0;
      const isDefault = input.isActive && (input.isDefault || first);
      if (isDefault) await tx.printer.updateMany({ where: { restaurantId: auth.restaurantId, role: input.role }, data: { isDefault: false } });
      return tx.printer.create({ data: { restaurantId: auth.restaurantId, ...connectionFields(input), name: input.name, role: input.role, paperWidth: input.paperWidth, isActive: input.isActive, isDefault }, include: printerInclude });
    });
    await this.audit.record(auth, { action: 'printer.created', entityType: 'printer', entityId: printer.id, after: toPrinterDto(printer) });
    return toPrinterDto(printer);
  }

  async updatePrinter(auth: AuthContext, id: string, input: z.output<typeof updatePrinterSchema>): Promise<PrinterDto> {
    const before = await this.findPrinter(auth, id);
    if (input.name && input.name !== before.name) await this.assertUniqueName(auth, input.name);
    const merged = {
      connection: input.connection ?? before.connection,
      host: input.host === undefined ? before.host : input.host,
      port: input.port === undefined ? before.port : input.port,
      devicePath: input.devicePath === undefined ? before.devicePath : input.devicePath,
    };
    if (merged.connection === 'NETWORK' && !merged.host) throw invalid('PRINTER_HOST_REQUIRED', 'Enter the IP address of the printer.');
    if ((merged.connection === 'USB' || merged.connection === 'BLUETOOTH') && !merged.devicePath) {
      throw invalid('PRINTER_DEVICE_REQUIRED', 'Enter the device or the printer name on the bridge computer.');
    }
    const role = input.role ?? before.role;
    const isActive = input.isActive ?? before.isActive;
    const isDefault = isActive && (input.isDefault ?? before.isDefault);
    const printer = await this.prisma.$transaction(async (tx) => {
      if (isDefault) await tx.printer.updateMany({ where: { restaurantId: auth.restaurantId, role, id: { not: id } }, data: { isDefault: false } });
      return tx.printer.update({
        where: { id },
        data: { ...connectionFields(merged), name: input.name ?? before.name, role, paperWidth: input.paperWidth ?? before.paperWidth, isActive, isDefault },
        include: printerInclude,
      });
    });
    await this.audit.record(auth, { action: 'printer.updated', entityType: 'printer', entityId: id, before: toPrinterDto(before), after: toPrinterDto(printer) });
    return toPrinterDto(printer);
  }

  async deletePrinter(auth: AuthContext, id: string): Promise<void> {
    const before = await this.findPrinter(auth, id);
    // Stations that printed here fall back to the default kitchen printer; jobs keep their history without it.
    await this.prisma.printer.delete({ where: { id } });
    await this.audit.record(auth, { action: 'printer.deleted', entityType: 'printer', entityId: id, before: toPrinterDto(before) });
  }

  private async findPrinter(auth: AuthContext, id: string): Promise<PrinterRow> {
    const printer = await this.prisma.printer.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: printerInclude });
    if (!printer) throw notFound('Printer');
    return printer;
  }

  private async assertUniqueName(auth: AuthContext, name: string): Promise<void> {
    const taken = await this.prisma.printer.findFirst({ where: { restaurantId: auth.restaurantId, name: { equals: name, mode: 'insensitive' } } });
    if (taken) throw conflict('NAME_TAKEN', 'Another printer already has this name.');
  }

  // ── Layouts ──

  async layouts(restaurantId: string): Promise<PrintLayoutsDto> {
    const rows = await this.prisma.printTemplate.findMany({ where: { restaurantId, name: LAYOUT_NAME, type: { in: ['RECEIPT', 'KOT'] } } });
    const config = (type: string) => (rows.find((row) => row.type === type)?.config as Record<string, unknown> | undefined) ?? {};
    // Parsing fills in the default for anything not stored, including options added after the row was written.
    return { receipt: receiptLayoutSchema.parse(config('RECEIPT')), kot: kotLayoutSchema.parse(config('KOT')) };
  }

  async updateLayouts(auth: AuthContext, input: z.output<typeof updatePrintLayoutsSchema>): Promise<PrintLayoutsDto> {
    const before = await this.layouts(auth.restaurantId);
    const next: PrintLayoutsDto = { receipt: { ...before.receipt, ...definedOnly(input.receipt) }, kot: { ...before.kot, ...definedOnly(input.kot) } };
    for (const [type, config] of [['RECEIPT', next.receipt], ['KOT', next.kot]] as const) {
      await this.prisma.printTemplate.upsert({
        where: { restaurantId_type_name: { restaurantId: auth.restaurantId, type, name: LAYOUT_NAME } },
        update: { config }, create: { restaurantId: auth.restaurantId, type, name: LAYOUT_NAME, config, isDefault: true },
      });
    }
    await this.audit.record(auth, { action: 'print_layout.updated', entityType: 'print_layout', before, after: next });
    return next;
  }

  // ── Bridges ──

  async listBridges(auth: AuthContext): Promise<BridgeDto[]> {
    const bridges = await this.prisma.printBridge.findMany({ where: { restaurantId: auth.restaurantId }, orderBy: { createdAt: 'asc' } });
    return bridges.map(toBridgeDto);
  }

  /** Adds a bridge and returns its token. The token is not stored, so it cannot be shown again. */
  async createBridge(auth: AuthContext, input: z.output<typeof createBridgeSchema>): Promise<BridgeCreatedDto> {
    const taken = await this.prisma.printBridge.findFirst({ where: { restaurantId: auth.restaurantId, name: { equals: input.name, mode: 'insensitive' } } });
    if (taken) throw conflict('NAME_TAKEN', 'Another print bridge already has this name.');
    const token = 'pb_' + randomBytes(32).toString('base64url');
    const bridge = await this.prisma.printBridge.create({ data: { restaurantId: auth.restaurantId, name: input.name, tokenHash: hashBridgeToken(token) } });
    await this.audit.record(auth, { action: 'print_bridge.created', entityType: 'print_bridge', entityId: bridge.id, after: { name: bridge.name } });
    return { ...toBridgeDto(bridge), token };
  }

  /** Removes a bridge. Its token stops working at once. */
  async deleteBridge(auth: AuthContext, id: string): Promise<void> {
    const bridge = await this.prisma.printBridge.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!bridge) throw notFound('Print bridge');
    await this.prisma.printBridge.delete({ where: { id } });
    await this.audit.record(auth, { action: 'print_bridge.deleted', entityType: 'print_bridge', entityId: id, before: { name: bridge.name } });
  }

  async bridgeOnline(restaurantId: string): Promise<boolean> {
    const seen = await this.prisma.printBridge.findFirst({ where: { restaurantId, lastSeenAt: { gte: new Date(Date.now() - BRIDGE_ONLINE_MS) } }, select: { id: true } });
    return seen !== null;
  }

  /** What a billing screen needs to choose between the bridge and the browser's print dialog. */
  async status(auth: AuthContext): Promise<PrintingStatusDto> {
    const [bridgeOnline, printers] = await Promise.all([
      this.bridgeOnline(auth.restaurantId),
      this.prisma.printer.findMany({ where: { restaurantId: auth.restaurantId, isActive: true, connection: { not: 'BROWSER' } }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
    ]);
    const receipt = printers.find((printer) => printer.role === 'RECEIPT' && printer.isDefault) ?? null;
    return {
      bridgeOnline,
      receiptPrinter: receipt && { id: receipt.id, name: receipt.name, paperWidth: receipt.paperWidth },
      kitchenPrinters: printers.some((printer) => printer.role === 'KOT'),
    };
  }
}

/** Only the fields that belong to the chosen kind of connection are kept. */
function connectionFields(input: { connection: 'NETWORK' | 'USB' | 'BLUETOOTH' | 'BROWSER'; host?: string | null | undefined; port?: number | null | undefined; devicePath?: string | null | undefined }) {
  if (input.connection === 'NETWORK') return { connection: input.connection, host: input.host ?? null, port: input.port ?? 9100, devicePath: null };
  if (input.connection === 'BROWSER') return { connection: input.connection, host: null, port: null, devicePath: null };
  return { connection: input.connection, host: null, port: null, devicePath: input.devicePath ?? null };
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, inner]) => inner !== undefined)) as Partial<T>;
}

function toPrinterDto(printer: PrinterRow): PrinterDto {
  return {
    id: printer.id, name: printer.name, role: printer.role, connection: printer.connection, paperWidth: printer.paperWidth, host: printer.host, port: printer.port,
    devicePath: printer.devicePath, isDefault: printer.isDefault, isActive: printer.isActive, lastStatus: printer.lastStatus, lastError: printer.lastError,
    lastSeenAt: printer.lastSeenAt?.toISOString() ?? null, stations: printer.stations.map((station) => station.name),
  };
}

function toBridgeDto(bridge: Prisma.PrintBridgeGetPayload<object>): BridgeDto {
  return {
    id: bridge.id, name: bridge.name, version: bridge.version, lastSeenAt: bridge.lastSeenAt?.toISOString() ?? null,
    online: bridge.lastSeenAt !== null && Date.now() - bridge.lastSeenAt.getTime() < BRIDGE_ONLINE_MS,
  };
}
