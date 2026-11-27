import { Injectable } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import { GST_STATES } from '@pos/types';
import { subscriptionOf } from '@pos/validation';
import type {
  createTerminalSchema, RestaurantDto, SettingsDto, StationDto, stationSchema, TaxGroupDto, taxGroupSchema, TerminalDto,
  updateRestaurantSchema, updateSettingsSchema, updateStationSchema, updateTaxGroupSchema, updateTerminalSchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../files/storage.service.js';

type TaxGroupRow = Prisma.TaxGroupGetPayload<{ include: { components: true; _count: { select: { products: true } } } }>;
const taxInclude = { components: true, _count: { select: { products: { where: { deletedAt: null } } } } } as const;
const COMPONENT_ORDER = ['CGST', 'SGST', 'IGST', 'CESS'] as const;

function toTaxGroupDto(group: TaxGroupRow): TaxGroupDto {
  const rate = (type: string) => group.components.find((component) => component.type === type)?.rateBps ?? 0;
  return {
    id: group.id,
    name: group.name,
    isActive: group.isActive,
    gstRateBps: rate('IGST'),
    cessRateBps: rate('CESS'),
    components: COMPONENT_ORDER.flatMap((type) =>
      group.components.filter((c) => c.type === type).map((c) => ({ type, name: c.name, rateBps: c.rateBps })),
    ),
    productCount: group._count.products,
  };
}

/** CGST and SGST are each half the GST rate and apply within a state; IGST is the full rate across states. */
function taxComponents(gstRateBps: number, cessRateBps: number) {
  return [
    { type: 'CGST' as const, name: 'CGST', rateBps: gstRateBps / 2 },
    { type: 'SGST' as const, name: 'SGST', rateBps: gstRateBps / 2 },
    { type: 'IGST' as const, name: 'IGST', rateBps: gstRateBps },
    ...(cessRateBps > 0 ? [{ type: 'CESS' as const, name: 'Cess', rateBps: cessRateBps }] : []),
  ];
}

@Injectable()
export class RestaurantService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Profile ──

  async getRestaurant(auth: AuthContext): Promise<RestaurantDto> {
    return this.toRestaurantDto(await this.prisma.restaurant.findUniqueOrThrow({ where: { id: auth.restaurantId } }));
  }

  async updateRestaurant(auth: AuthContext, input: z.output<typeof updateRestaurantSchema>): Promise<RestaurantDto> {
    const before = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: auth.restaurantId }, include: { settings: true } });
    const gstin = input.gstin === undefined ? before.gstin : input.gstin;
    const stateCode = input.stateCode ?? before.stateCode;
    if (gstin && !gstin.startsWith(stateCode)) {
      throw invalid('GSTIN_STATE_MISMATCH', 'The first two digits of the GSTIN must match the state.');
    }
    if (!gstin && before.settings && before.settings.gstRegistration !== 'UNREGISTERED') {
      throw invalid('GSTIN_REQUIRED', 'A GST-registered restaurant needs a GSTIN. Change the GST registration type first.');
    }
    const updated = await this.prisma.restaurant.update({
      where: { id: auth.restaurantId },
      data: { ...input, stateName: GST_STATES[stateCode] },
    });
    await this.audit.record(auth, {
      action: 'restaurant.updated', entityType: 'restaurant', entityId: updated.id,
      before: this.toRestaurantDto(before), after: this.toRestaurantDto(updated),
    });
    return this.toRestaurantDto(updated);
  }

  private toRestaurantDto(r: Prisma.RestaurantGetPayload<object>): RestaurantDto {
    return {
      id: r.id, name: r.name, legalName: r.legalName, gstin: r.gstin, fssaiNumber: r.fssaiNumber, phone: r.phone,
      email: r.email, addressLine1: r.addressLine1, addressLine2: r.addressLine2, city: r.city, stateCode: r.stateCode,
      stateName: r.stateName, pincode: r.pincode, logoUrl: this.storage.publicUrl(r.logoUrl), subscription: subscriptionOf(r),
    };
  }

  // ── Billing settings ──

  async getSettings(auth: AuthContext): Promise<SettingsDto> {
    const settings = await this.prisma.restaurantSettings.upsert({
      where: { restaurantId: auth.restaurantId },
      update: {},
      create: { restaurantId: auth.restaurantId },
    });
    const { restaurantId: _restaurantId, updatedAt: _updatedAt, ...dto } = settings;
    return dto;
  }

  async updateSettings(auth: AuthContext, input: z.output<typeof updateSettingsSchema>): Promise<SettingsDto> {
    const before = await this.getSettings(auth);
    if (input.gstRegistration && input.gstRegistration !== 'UNREGISTERED') {
      const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: auth.restaurantId } });
      if (!restaurant.gstin) throw invalid('GSTIN_REQUIRED', 'Enter the restaurant GSTIN before choosing this registration type.');
    }
    if (input.defaultTaxGroupId) {
      const group = await this.prisma.taxGroup.findFirst({
        where: { id: input.defaultTaxGroupId, restaurantId: auth.restaurantId, isActive: true },
      });
      if (!group) throw invalid('TAX_GROUP_NOT_FOUND', 'Choose an active tax group as the default.');
    }
    await this.prisma.restaurantSettings.update({ where: { restaurantId: auth.restaurantId }, data: input });
    const after = await this.getSettings(auth);
    await this.audit.record(auth, { action: 'settings.updated', entityType: 'settings', entityId: auth.restaurantId, before, after });
    return after;
  }

  // ── Tax groups ──

  async listTaxGroups(auth: AuthContext): Promise<TaxGroupDto[]> {
    const groups = await this.prisma.taxGroup.findMany({
      where: { restaurantId: auth.restaurantId }, include: taxInclude, orderBy: { name: 'asc' },
    });
    return groups.map(toTaxGroupDto);
  }

  async createTaxGroup(auth: AuthContext, input: z.output<typeof taxGroupSchema>): Promise<TaxGroupDto> {
    await this.assertUniqueName('taxGroup', auth, input.name);
    const group = await this.prisma.taxGroup.create({
      data: {
        restaurantId: auth.restaurantId,
        name: input.name,
        isActive: input.isActive,
        components: { create: taxComponents(input.gstRateBps, input.cessRateBps) },
      },
      include: taxInclude,
    });
    await this.audit.record(auth, { action: 'tax_group.created', entityType: 'tax_group', entityId: group.id, after: toTaxGroupDto(group) });
    return toTaxGroupDto(group);
  }

  async updateTaxGroup(auth: AuthContext, id: string, input: z.output<typeof updateTaxGroupSchema>): Promise<TaxGroupDto> {
    const before = await this.findTaxGroup(auth, id);
    if (input.name && input.name !== before.name) await this.assertUniqueName('taxGroup', auth, input.name);
    if (input.isActive === false) await this.assertNotDefaultTaxGroup(auth, id);

    const current = toTaxGroupDto(before);
    const gstRateBps = input.gstRateBps ?? current.gstRateBps;
    const cessRateBps = input.cessRateBps ?? current.cessRateBps;
    const rateChanged = gstRateBps !== current.gstRateBps || cessRateBps !== current.cessRateBps;

    // Issued invoices keep their own copy of the rates, so changing a rate only affects new bills.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (rateChanged) {
        await tx.taxComponent.deleteMany({ where: { taxGroupId: id } });
        await tx.taxComponent.createMany({ data: taxComponents(gstRateBps, cessRateBps).map((c) => ({ taxGroupId: id, ...c })) });
      }
      return tx.taxGroup.update({ where: { id }, data: { name: input.name, isActive: input.isActive }, include: taxInclude });
    });
    await this.audit.record(auth, {
      action: 'tax_group.updated', entityType: 'tax_group', entityId: id, before: current, after: toTaxGroupDto(updated),
    });
    return toTaxGroupDto(updated);
  }

  async deleteTaxGroup(auth: AuthContext, id: string): Promise<void> {
    const group = await this.findTaxGroup(auth, id);
    await this.assertNotDefaultTaxGroup(auth, id);
    const used = await this.prisma.product.count({ where: { taxGroupId: id } });
    if (used > 0) {
      throw conflict('TAX_GROUP_IN_USE', 'Products use this tax group. Mark it inactive instead, or move the products first.');
    }
    await this.prisma.taxGroup.delete({ where: { id } });
    await this.audit.record(auth, { action: 'tax_group.deleted', entityType: 'tax_group', entityId: id, before: toTaxGroupDto(group) });
  }

  private async findTaxGroup(auth: AuthContext, id: string): Promise<TaxGroupRow> {
    const group = await this.prisma.taxGroup.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: taxInclude });
    if (!group) throw notFound('Tax group');
    return group;
  }

  private async assertNotDefaultTaxGroup(auth: AuthContext, id: string): Promise<void> {
    const settings = await this.prisma.restaurantSettings.findUnique({ where: { restaurantId: auth.restaurantId } });
    if (settings?.defaultTaxGroupId === id) {
      throw conflict('TAX_GROUP_IS_DEFAULT', 'This is the default tax group. Choose another default in billing settings first.');
    }
  }

  // ── Terminals ──

  async listTerminals(auth: AuthContext): Promise<TerminalDto[]> {
    // A device's hidden offline till is not a counter anyone chooses or edits.
    const terminals = await this.prisma.terminal.findMany({ where: { restaurantId: auth.restaurantId, kind: 'COUNTER' }, orderBy: { code: 'asc' } });
    return terminals.map(this.toTerminalDto);
  }

  async createTerminal(auth: AuthContext, input: z.output<typeof createTerminalSchema>): Promise<TerminalDto> {
    const clash = await this.prisma.terminal.findUnique({ where: { restaurantId_code: { restaurantId: auth.restaurantId, code: input.code } } });
    if (clash) throw conflict('TERMINAL_CODE_TAKEN', `Terminal code ${input.code} is already used.`);
    const terminal = await this.prisma.terminal.create({ data: { restaurantId: auth.restaurantId, ...input } });
    await this.audit.record(auth, { action: 'terminal.created', entityType: 'terminal', entityId: terminal.id, after: terminal });
    return this.toTerminalDto(terminal);
  }

  /** The code is fixed for life: it is part of every invoice number the terminal has issued. */
  async updateTerminal(auth: AuthContext, id: string, input: z.output<typeof updateTerminalSchema>): Promise<TerminalDto> {
    const before = await this.prisma.terminal.findFirst({ where: { id, restaurantId: auth.restaurantId, kind: 'COUNTER' } });
    if (!before) throw notFound('Terminal');
    const terminal = await this.prisma.terminal.update({ where: { id }, data: input });
    await this.audit.record(auth, { action: 'terminal.updated', entityType: 'terminal', entityId: id, before, after: terminal });
    return this.toTerminalDto(terminal);
  }

  private toTerminalDto(t: Prisma.TerminalGetPayload<object>): TerminalDto {
    return { id: t.id, code: t.code, name: t.name, isActive: t.isActive, lastSeenAt: t.lastSeenAt?.toISOString() ?? null };
  }

  // ── Kitchen stations ──

  async listStations(auth: AuthContext): Promise<StationDto[]> {
    const stations = await this.prisma.kitchenStation.findMany({
      where: { restaurantId: auth.restaurantId },
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return stations.map((s) => ({ id: s.id, name: s.name, sortOrder: s.sortOrder, isActive: s.isActive, productCount: s._count.products, printerId: s.printerId, fallbackPrinterId: s.fallbackPrinterId }));
  }

  async createStation(auth: AuthContext, input: z.output<typeof stationSchema>): Promise<StationDto> {
    await this.assertUniqueName('kitchenStation', auth, input.name);
    await this.assertOwnPrinters(auth, [input.printerId, input.fallbackPrinterId]);
    const last = await this.prisma.kitchenStation.aggregate({ where: { restaurantId: auth.restaurantId }, _max: { sortOrder: true } });
    const station = await this.prisma.kitchenStation.create({
      data: { restaurantId: auth.restaurantId, ...input, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
    await this.audit.record(auth, { action: 'station.created', entityType: 'kitchen_station', entityId: station.id, after: station });
    return { id: station.id, name: station.name, sortOrder: station.sortOrder, isActive: station.isActive, productCount: 0, printerId: station.printerId, fallbackPrinterId: station.fallbackPrinterId };
  }

  async updateStation(auth: AuthContext, id: string, input: z.output<typeof updateStationSchema>): Promise<StationDto> {
    const before = await this.prisma.kitchenStation.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!before) throw notFound('Kitchen station');
    if (input.name && input.name !== before.name) await this.assertUniqueName('kitchenStation', auth, input.name);
    await this.assertOwnPrinters(auth, [input.printerId, input.fallbackPrinterId]);
    const station = await this.prisma.kitchenStation.update({ where: { id }, data: input });
    await this.audit.record(auth, { action: 'station.updated', entityType: 'kitchen_station', entityId: id, before, after: station });
    return (await this.listStations(auth)).find((s) => s.id === id)!;
  }

  async deleteStation(auth: AuthContext, id: string): Promise<void> {
    const station = await this.prisma.kitchenStation.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!station) throw notFound('Kitchen station');
    const used = await this.prisma.product.count({ where: { stationId: id, deletedAt: null } });
    if (used > 0) throw conflict('STATION_IN_USE', `${used} product(s) are sent to this station. Move them to another station first.`);
    await this.prisma.kitchenStation.delete({ where: { id } });
    await this.audit.record(auth, { action: 'station.deleted', entityType: 'kitchen_station', entityId: id, before: station });
  }

  /** A station can only print on this restaurant's printers. */
  private async assertOwnPrinters(auth: AuthContext, ids: (string | null | undefined)[]): Promise<void> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (wanted.length === 0) return;
    const found = await this.prisma.printer.count({ where: { id: { in: wanted }, restaurantId: auth.restaurantId } });
    if (found !== wanted.length) throw invalid('PRINTER_NOT_FOUND', 'Choose a printer from the list.');
  }

  private async assertUniqueName(model: 'taxGroup' | 'kitchenStation', auth: AuthContext, name: string): Promise<void> {
    const where = { restaurantId: auth.restaurantId, name: { equals: name, mode: 'insensitive' as const } };
    const clash = model === 'taxGroup' ? await this.prisma.taxGroup.findFirst({ where }) : await this.prisma.kitchenStation.findFirst({ where });
    if (clash) throw conflict('NAME_TAKEN', `"${name}" already exists.`);
  }
}
