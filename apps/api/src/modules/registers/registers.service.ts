import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@pos/database';
import { PAPER_COLUMNS, type PaperWidthKey, type PrintDocument, REALTIME_EVENTS } from '@pos/types';
import type {
  cashMovementSchema, closeRegisterSchema, openRegisterSchema, Page, PaymentMethod, PrintJobDto, printRequestSchema, RegisterDetailDto, registerQuerySchema, RegisterSessionDto,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { ApprovalsService } from '../billing/approvals.service.js';
import { asDate, BillingContextService, type Db, fromDate } from '../billing/billing-context.js';
import { renderRegisterReport } from '@pos/printing';
import { PrintQueueService } from '../printing/print-queue.service.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';

const sessionInclude = {
  user: { select: { id: true, name: true } },
  closedBy: { select: { name: true } },
  terminal: { select: { id: true, code: true, name: true } },
} as const;
type SessionRow = Prisma.CashRegisterSessionGetPayload<{ include: typeof sessionInclude }>;

/** The cash that moved through a register, apart from its opening float. */
interface CashFigures {
  cashInPaise: number;
  cashOutPaise: number;
  cashSalesPaise: number;
  cashRefundsPaise: number;
}
const NO_CASH: CashFigures = { cashInPaise: 0, cashOutPaise: 0, cashSalesPaise: 0, cashRefundsPaise: 0 };
const expectedOf = (openingCashPaise: number, cash: CashFigures) =>
  openingCashPaise + cash.cashInPaise - cash.cashOutPaise + cash.cashSalesPaise - cash.cashRefundsPaise;

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'OTHER'];

/**
 * Cash register sessions: a cashier opens a register with a float, takes cash against bills, and closes it by
 * counting the drawer. What should be in the drawer is always worked out from the payments and refunds linked
 * to the session, so a corrected or erased bill changes it too; closing records the figure as it then stood.
 */
@Injectable()
export class RegistersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly printQueue: PrintQueueService,
  ) {}

  // ── Reading ──

  async current(auth: AuthContext): Promise<RegisterDetailDto | null> {
    const session = await this.prisma.cashRegisterSession.findFirst({ where: { restaurantId: auth.restaurantId, userId: auth.userId, status: 'OPEN' }, include: sessionInclude });
    return session ? this.detail(session) : null;
  }

  async get(auth: AuthContext, id: string): Promise<RegisterDetailDto> {
    return this.detail(await this.find(auth, id));
  }

  async list(auth: AuthContext, query: z.output<typeof registerQuerySchema>): Promise<Page<RegisterSessionDto>> {
    const where: Prisma.CashRegisterSessionWhereInput = {
      restaurantId: auth.restaurantId,
      // Without the right to see every register, a cashier sees their own.
      ...(auth.permissions.has('register.view_all') ? (query.userId ? { userId: query.userId } : {}) : { userId: auth.userId }),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to ? { businessDate: { ...(query.from ? { gte: asDate(query.from) } : {}), ...(query.to ? { lte: asDate(query.to) } : {}) } } : {}),
    };
    const direction = query.direction;
    const last = { sort: direction, nulls: 'last' } as const;
    const orderBy: Prisma.CashRegisterSessionOrderByWithRelationInput = {
      opened: { openedAt: direction }, closed: { closedAt: last }, cashier: { user: { name: direction } }, terminal: { terminal: { code: direction } },
      opening: { openingCashPaise: direction }, expected: { expectedCashPaise: last }, counted: { countedCashPaise: last }, variance: { variancePaise: last },
      status: { status: direction },
    }[query.sort];
    const [total, rows] = await Promise.all([
      this.prisma.cashRegisterSession.count({ where }),
      this.prisma.cashRegisterSession.findMany({
        where, include: sessionInclude, orderBy: [orderBy, { openedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
    ]);
    const cash = await this.cashOf(this.prisma, rows.map((row) => row.id));
    return { items: rows.map((row) => this.toDto(row, cash.get(row.id) ?? NO_CASH)), total, page: query.page, pageSize: query.pageSize };
  }

  /** Sends the register report (opening, takings, cash in and out, count) to the receipt printer. */
  async print(auth: AuthContext, id: string, input: z.output<typeof printRequestSchema>): Promise<PrintJobDto> {
    const [register, ctx] = await Promise.all([this.get(auth, id), this.context.load(auth.restaurantId)]);
    const job = await this.printQueue.queue(auth.restaurantId, {
      type: 'REGISTER_REPORT', role: 'RECEIPT', refType: 'register', refId: id, title: 'Register report for ' + register.user.name, printerId: input.printerId,
      requestedById: auth.userId, render: (columns) => renderRegisterReport(register, ctx.restaurant.name, columns, ctx.settings.timezone),
    });
    return job!;
  }

  /** The register report laid out as lines of text, for a printer connected to the asking device. */
  async printDocument(auth: AuthContext, id: string, width: PaperWidthKey): Promise<PrintDocument> {
    const [register, ctx] = await Promise.all([this.get(auth, id), this.context.load(auth.restaurantId)]);
    return renderRegisterReport(register, ctx.restaurant.name, PAPER_COLUMNS[width], ctx.settings.timezone);
  }

  // ── Changing ──

  async open(auth: AuthContext, input: z.output<typeof openRegisterSchema>): Promise<RegisterDetailDto> {
    const ctx = await this.context.load(auth.restaurantId);
    let id: string;
    try {
      const session = await this.prisma.cashRegisterSession.create({
        data: {
          restaurantId: auth.restaurantId, userId: auth.userId, terminalId: auth.terminalId, status: 'OPEN',
          businessDate: asDate(ctx.businessDate), openingCashPaise: input.openingCashPaise,
        },
      });
      id = session.id;
    } catch (error) {
      // The database allows one open register per person.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('REGISTER_ALREADY_OPEN', 'You already have a cash register open. Close it before opening another.');
      }
      throw error;
    }
    await this.audit.record(auth, { action: 'register.opened', entityType: 'register', entityId: id, after: { openingCashPaise: input.openingCashPaise } });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.registerUpdated, { registerId: id });
    return this.get(auth, id);
  }

  /** Cash put into or taken out of the caller's open register, for a stated reason (change brought in, a supplier paid). */
  async move(auth: AuthContext, input: z.output<typeof cashMovementSchema>): Promise<RegisterDetailDto> {
    const approvedBy = await this.approvals.resolve(auth, 'register.adjust', input.approval);
    const id = await this.prisma.$transaction(async (tx) => {
      const session = await this.lockOwnOpen(tx, auth);
      if (input.type === 'CASH_OUT') {
        const inDrawer = expectedOf(session.opening_cash_paise, (await this.cashOf(tx, [session.id])).get(session.id) ?? NO_CASH);
        if (input.amountPaise > inDrawer) throw invalid('CASH_OUT_TOO_LARGE', `Only ${rupees(inDrawer)} should be in the drawer.`);
      }
      await tx.cashRegisterTransaction.create({
        data: { sessionId: session.id, type: input.type, amountPaise: input.amountPaise, reason: input.reason, createdById: auth.userId },
      });
      await this.audit.record(auth, {
        action: input.type === 'CASH_IN' ? 'register.cash_in' : 'register.cash_out', entityType: 'register', entityId: session.id, reason: input.reason,
        after: { amountPaise: input.amountPaise, approvedBy },
      }, tx);
      return session.id;
    });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.registerUpdated, { registerId: id });
    return this.get(auth, id);
  }

  /**
   * Closes a register against the cash counted in its drawer. The cashier closes their own; someone who may see
   * every register can close one left open by somebody else. A closed register is never reopened or changed.
   */
  async close(auth: AuthContext, id: string, input: z.output<typeof closeRegisterSchema>): Promise<RegisterDetailDto> {
    const seen = await this.find(auth, id);
    if (seen.userId !== auth.userId && !auth.permissions.has('register.view_all')) throw forbidden('You can only close your own cash register.');
    if (seen.userId === auth.userId && !auth.permissions.has('register.operate') && !auth.permissions.has('register.view_all')) {
      throw forbidden('You do not have permission to close a cash register.');
    }
    const closed = await this.prisma.$transaction(async (tx) => {
      // Held for writing: payments being recorded into this register finish first, and none can start.
      const rows = await tx.$queryRaw<{ status: string; opening_cash_paise: number }[]>`
        SELECT status, opening_cash_paise FROM cash_register_sessions WHERE id = ${id}::uuid AND restaurant_id = ${auth.restaurantId}::uuid FOR UPDATE`;
      const session = rows[0];
      if (!session) throw notFound('Cash register');
      if (session.status !== 'OPEN') throw conflict('REGISTER_CLOSED', 'This cash register is already closed.');
      const cash = (await this.cashOf(tx, [id])).get(id) ?? NO_CASH;
      const expected = expectedOf(session.opening_cash_paise, cash);
      const variance = input.countedCashPaise - expected;
      await tx.cashRegisterSession.update({
        where: { id },
        data: {
          status: 'CLOSED', expectedCashPaise: expected, countedCashPaise: input.countedCashPaise, variancePaise: variance,
          denominations: input.denominations ?? Prisma.DbNull, closingNotes: input.notes ?? null, closedById: auth.userId, closedAt: new Date(),
        },
      });
      await this.audit.record(auth, {
        action: 'register.closed', entityType: 'register', entityId: id, reason: input.notes ?? null,
        after: { ...cash, openingCashPaise: session.opening_cash_paise, expectedCashPaise: expected, countedCashPaise: input.countedCashPaise, variancePaise: variance, cashier: seen.user.name },
      }, tx);
      return id;
    });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.registerUpdated, { registerId: closed });
    return this.get(auth, closed);
  }

  // ── Internals ──

  private async find(auth: AuthContext, id: string): Promise<SessionRow> {
    const session = await this.prisma.cashRegisterSession.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: sessionInclude });
    if (!session || (session.userId !== auth.userId && !auth.permissions.has('register.view_all'))) throw notFound('Cash register');
    return session;
  }

  private async lockOwnOpen(tx: Prisma.TransactionClient, auth: AuthContext) {
    const rows = await tx.$queryRaw<{ id: string; opening_cash_paise: number }[]>`
      SELECT id, opening_cash_paise FROM cash_register_sessions
      WHERE user_id = ${auth.userId}::uuid AND restaurant_id = ${auth.restaurantId}::uuid AND status = 'OPEN' FOR UPDATE`;
    if (!rows[0]) throw conflict('REGISTER_NOT_OPEN', 'Open your cash register first.');
    return rows[0];
  }

  /** Cash in, cash out, cash sales and cash refunds for each of the given sessions. */
  private async cashOf(db: Db, ids: string[]): Promise<Map<string, CashFigures>> {
    const figures = new Map<string, CashFigures>(ids.map((id) => [id, { ...NO_CASH }]));
    if (ids.length === 0) return figures;
    const [moves, sales, refunds] = await Promise.all([
      db.cashRegisterTransaction.groupBy({ by: ['sessionId', 'type'], where: { sessionId: { in: ids }, type: { in: ['CASH_IN', 'CASH_OUT'] } }, _sum: { amountPaise: true } }),
      db.payment.groupBy({ by: ['registerSessionId'], where: { registerSessionId: { in: ids }, method: 'CASH', status: 'SUCCESS' }, _sum: { amountPaise: true } }),
      db.refund.groupBy({ by: ['registerSessionId'], where: { registerSessionId: { in: ids }, method: 'CASH', status: 'SUCCESS' }, _sum: { amountPaise: true } }),
    ]);
    for (const move of moves) figures.get(move.sessionId)![move.type === 'CASH_IN' ? 'cashInPaise' : 'cashOutPaise'] = move._sum.amountPaise ?? 0;
    for (const sale of sales) if (sale.registerSessionId) figures.get(sale.registerSessionId)!.cashSalesPaise = sale._sum.amountPaise ?? 0;
    for (const refund of refunds) if (refund.registerSessionId) figures.get(refund.registerSessionId)!.cashRefundsPaise = refund._sum.amountPaise ?? 0;
    return figures;
  }

  private toDto(row: SessionRow, cash: CashFigures): RegisterSessionDto {
    return {
      id: row.id, status: row.status, businessDate: fromDate(row.businessDate), terminal: row.terminal, user: row.user,
      openedAt: row.openedAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null, closedByName: row.closedBy?.name ?? null,
      openingCashPaise: row.openingCashPaise, ...cash,
      // A closed register shows the figure it was counted against, whatever was corrected afterwards.
      expectedCashPaise: row.expectedCashPaise ?? expectedOf(row.openingCashPaise, cash),
      countedCashPaise: row.countedCashPaise, variancePaise: row.variancePaise,
      denominations: (row.denominations as Record<string, number> | null) ?? null, closingNotes: row.closingNotes,
    };
  }

  private async detail(row: SessionRow): Promise<RegisterDetailDto> {
    const [cash, received, refunded, moves] = await Promise.all([
      this.cashOf(this.prisma, [row.id]),
      this.prisma.payment.groupBy({ by: ['method'], where: { registerSessionId: row.id, status: 'SUCCESS' }, _sum: { amountPaise: true }, _count: true }),
      this.prisma.refund.groupBy({ by: ['method'], where: { registerSessionId: row.id, status: 'SUCCESS' }, _sum: { amountPaise: true } }),
      this.prisma.cashRegisterTransaction.findMany({ where: { sessionId: row.id, type: { in: ['CASH_IN', 'CASH_OUT'] } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const names = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: [...new Set(moves.map((move) => move.createdById))] } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]),
    );
    const takings = METHODS.map((method) => ({
      method,
      count: received.find((entry) => entry.method === method)?._count ?? 0,
      receivedPaise: received.find((entry) => entry.method === method)?._sum.amountPaise ?? 0,
      refundedPaise: refunded.find((entry) => entry.method === method)?._sum.amountPaise ?? 0,
    })).filter((entry) => entry.count > 0 || entry.refundedPaise > 0);
    return {
      ...this.toDto(row, cash.get(row.id) ?? NO_CASH),
      takings,
      movements: moves.map((move) => ({
        id: move.id, type: move.type as 'CASH_IN' | 'CASH_OUT', amountPaise: move.amountPaise, reason: move.reason,
        createdByName: names.get(move.createdById) ?? 'Unknown', createdAt: move.createdAt.toISOString(),
      })),
    };
  }
}
