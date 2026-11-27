import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@pos/database';
import { REALTIME_EVENTS } from '@pos/types';
import type { AreaDto, areaSchema, createTableSchema, LayoutInput, TableDto, updateTableSchema } from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { displayNumber } from './mappers.js';

const RUNNING = ['OPEN', 'HELD', 'BILLED'] as const;
const GRID = 160;
const COLUMNS = 5;

/** Dining areas and tables: what the floor looks like, as opposed to what is happening on it. */
@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  /** Tables with their position on the floor and the order running at each, if any. */
  async list(auth: AuthContext): Promise<TableDto[]> {
    const tables = await this.prisma.diningTable.findMany({
      where: { restaurantId: auth.restaurantId, isActive: true },
      include: {
        area: true,
        orders: { where: { status: { in: [...RUNNING] } }, select: { id: true, series: true, orderNumber: true, totalPaise: true, status: true } },
      },
      orderBy: [{ area: { sortOrder: 'asc' } }, { name: 'asc' }],
    });
    return tables.map((t) => {
      const order = t.orders[0] ?? null;
      return {
        id: t.id, name: t.name, areaId: t.areaId, areaName: t.area.name, seats: t.seats, status: t.status, shape: t.shape,
        posX: t.posX, posY: t.posY, width: t.width, height: t.height,
        orderId: order?.id ?? null, orderDisplayNumber: order ? displayNumber(order) : null, orderTotalPaise: order?.totalPaise ?? null,
      };
    });
  }

  // ── Areas ──

  async listAreas(auth: AuthContext): Promise<AreaDto[]> {
    const areas = await this.prisma.area.findMany({
      where: { restaurantId: auth.restaurantId },
      include: { _count: { select: { tables: { where: { isActive: true } } } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return areas.map((area) => ({ id: area.id, name: area.name, sortOrder: area.sortOrder, tableCount: area._count.tables }));
  }

  async createArea(auth: AuthContext, input: z.output<typeof areaSchema>): Promise<AreaDto> {
    await this.assertAreaNameFree(auth, input.name);
    const last = await this.prisma.area.aggregate({ where: { restaurantId: auth.restaurantId }, _max: { sortOrder: true } });
    const area = await this.prisma.area.create({ data: { restaurantId: auth.restaurantId, name: input.name, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    await this.changed(auth, 'area.created', area.id, { name: area.name });
    return { id: area.id, name: area.name, sortOrder: area.sortOrder, tableCount: 0 };
  }

  async updateArea(auth: AuthContext, id: string, input: z.output<typeof areaSchema>): Promise<AreaDto> {
    const area = await this.prisma.area.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!area) throw notFound('Area');
    if (input.name.toLowerCase() !== area.name.toLowerCase()) await this.assertAreaNameFree(auth, input.name);
    await this.prisma.area.update({ where: { id }, data: { name: input.name } });
    await this.changed(auth, 'area.updated', id, { from: area.name, to: input.name });
    return (await this.listAreas(auth)).find((entry) => entry.id === id)!;
  }

  async deleteArea(auth: AuthContext, id: string): Promise<void> {
    const area = await this.prisma.area.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { _count: { select: { tables: { where: { isActive: true } } } } } });
    if (!area) throw notFound('Area');
    if (area._count.tables > 0) throw conflict('AREA_NOT_EMPTY', 'Move or delete the ' + area._count.tables + ' table(s) in "' + area.name + '" first.');
    // Tables removed earlier are kept, inactive, for order history; they go with their area.
    await this.prisma.$transaction([
      this.prisma.diningTable.deleteMany({ where: { areaId: id, isActive: false } }),
      this.prisma.area.delete({ where: { id } }),
    ]);
    await this.changed(auth, 'area.deleted', id, { name: area.name });
  }

  private async assertAreaNameFree(auth: AuthContext, name: string): Promise<void> {
    const clash = await this.prisma.area.findFirst({ where: { restaurantId: auth.restaurantId, name: { equals: name, mode: 'insensitive' } } });
    if (clash) throw conflict('NAME_TAKEN', 'An area named "' + name + '" already exists.');
  }

  // ── Tables ──

  async createTable(auth: AuthContext, input: z.output<typeof createTableSchema>): Promise<TableDto> {
    await this.assertArea(auth, input.areaId);
    await this.assertTableNameFree(auth, input.areaId, input.name);
    // Without a position, a new table takes the next free slot on a simple grid.
    const count = await this.prisma.diningTable.count({ where: { areaId: input.areaId, isActive: true } });
    const table = await this.prisma.diningTable.create({
      data: {
        restaurantId: auth.restaurantId, areaId: input.areaId, name: input.name, seats: input.seats, shape: input.shape,
        posX: input.posX ?? 40 + (count % COLUMNS) * GRID, posY: input.posY ?? 40 + Math.floor(count / COLUMNS) * GRID,
        width: input.width ?? (input.shape === 'RECTANGLE' ? 128 : 96), height: input.height ?? 96,
      },
    });
    await this.changed(auth, 'table.created', table.id, { name: table.name, seats: table.seats });
    return this.one(auth, table.id);
  }

  async updateTable(auth: AuthContext, id: string, input: z.output<typeof updateTableSchema>): Promise<TableDto> {
    const table = await this.find(auth, id);
    const areaId = input.areaId ?? table.areaId;
    if (input.areaId && input.areaId !== table.areaId) await this.assertArea(auth, input.areaId);
    const name = input.name ?? table.name;
    if (areaId !== table.areaId || name.toLowerCase() !== table.name.toLowerCase()) await this.assertTableNameFree(auth, areaId, name);

    let status = table.status;
    if (input.blocked === true && table.status !== 'BLOCKED') {
      if (await this.runningOrders(id)) throw conflict('TABLE_IN_USE', 'Table ' + table.name + ' has a running order and cannot be blocked now.');
      status = 'BLOCKED';
    } else if (input.blocked === false && table.status === 'BLOCKED') {
      status = 'FREE';
    }
    await this.prisma.diningTable.update({
      where: { id },
      data: { areaId, name, seats: input.seats, shape: input.shape, width: input.width, height: input.height, status },
    });
    await this.changed(auth, 'table.updated', id, { name, status });
    return this.one(auth, id);
  }

  /** Removes a table from the floor. It is kept, hidden, so past orders still show where they were served. */
  async deleteTable(auth: AuthContext, id: string): Promise<void> {
    const table = await this.find(auth, id);
    if (await this.runningOrders(id)) throw conflict('TABLE_IN_USE', 'Table ' + table.name + ' has a running order. Settle or move it first.');
    // The name is released so a new table can reuse it.
    await this.prisma.diningTable.update({ where: { id }, data: { isActive: false, status: 'FREE', name: table.name + ' (removed ' + id.slice(0, 8) + ')' } });
    await this.changed(auth, 'table.deleted', id, { name: table.name });
  }

  /** Saves where tables were dragged to in the floor editor. */
  async saveLayout(auth: AuthContext, input: LayoutInput): Promise<TableDto[]> {
    const ids = input.tables.map((table) => table.id);
    const owned = await this.prisma.diningTable.count({ where: { id: { in: ids }, restaurantId: auth.restaurantId, isActive: true } });
    if (owned !== new Set(ids).size || owned !== ids.length) throw invalid('LAYOUT_MISMATCH', 'The floor has changed. Refresh and try again.');
    await this.prisma.$transaction(input.tables.map((table) => this.prisma.diningTable.update({ where: { id: table.id }, data: { posX: table.posX, posY: table.posY } })));
    await this.changed(auth, 'table.layout_saved', null, { tables: ids.length });
    return this.list(auth);
  }

  private async find(auth: AuthContext, id: string) {
    const table = await this.prisma.diningTable.findFirst({ where: { id, restaurantId: auth.restaurantId, isActive: true } });
    if (!table) throw notFound('Table');
    return table;
  }

  private async one(auth: AuthContext, id: string): Promise<TableDto> {
    return (await this.list(auth)).find((table) => table.id === id)!;
  }

  private runningOrders(tableId: string): Promise<number> {
    return this.prisma.order.count({ where: { tableId, status: { in: [...RUNNING] } } });
  }

  private async assertArea(auth: AuthContext, areaId: string): Promise<void> {
    if (!(await this.prisma.area.findFirst({ where: { id: areaId, restaurantId: auth.restaurantId } }))) throw invalid('AREA_NOT_FOUND', 'Choose an area.');
  }

  private async assertTableNameFree(auth: AuthContext, areaId: string, name: string): Promise<void> {
    const clash = await this.prisma.diningTable.findFirst({
      where: { restaurantId: auth.restaurantId, areaId, isActive: true, name: { equals: name, mode: 'insensitive' } },
    });
    if (clash) throw conflict('NAME_TAKEN', 'This area already has a table named "' + name + '".');
  }

  private async changed(auth: AuthContext, action: string, entityId: string | null, after: Record<string, unknown>): Promise<void> {
    await this.audit.record(auth, { action, entityType: action.startsWith('area') ? 'area' : 'table', entityId, after });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.tableUpdated);
  }
}
