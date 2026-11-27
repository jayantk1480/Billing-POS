import { Injectable } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import type {
  Page, PaymentListItemDto, PaymentMethod, paymentQuerySchema, ReconciliationDto, reconciliationQuerySchema, ReconciliationRowDto, saveReconciliationSchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { asDate, BillingContextService, fromDate } from '../billing/billing-context.js';

const METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'OTHER'];

/**
 * Compares what the system recorded as received, per day and payment method, with what the manager says actually
 * arrived (the bank statement, the card machine's settlement, the UPI app). Nothing here changes a bill or a payment.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly audit: AuditService,
  ) {}

  async summary(auth: AuthContext, query: z.output<typeof reconciliationQuerySchema>): Promise<ReconciliationDto> {
    const range = { gte: asDate(query.from), lte: asDate(query.to) };
    const scope = { restaurantId: auth.restaurantId, businessDate: range, status: 'SUCCESS' as const };
    const [received, refunded, entries, cashIn, cashOut, sessions] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['businessDate', 'method'], where: scope, _sum: { amountPaise: true }, _count: true }),
      // A refund counts on the day the money went back, which may be later than the day of the bill.
      this.prisma.refund.groupBy({ by: ['businessDate', 'method'], where: scope, _sum: { amountPaise: true } }),
      this.prisma.paymentReconciliation.findMany({ where: { restaurantId: auth.restaurantId, businessDate: range } }),
      this.prisma.payment.groupBy({ by: ['registerSessionId'], where: { ...scope, method: 'CASH' }, _sum: { amountPaise: true } }),
      this.prisma.refund.groupBy({ by: ['registerSessionId'], where: { ...scope, method: 'CASH' }, _sum: { amountPaise: true } }),
      this.prisma.cashRegisterSession.findMany({ where: { restaurantId: auth.restaurantId, businessDate: range }, select: { status: true, variancePaise: true } }),
    ]);
    const names = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.reconciledById))] } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]),
    );

    const key = (date: Date, method: string) => `${fromDate(date)}|${method}`;
    const rows = new Map<string, ReconciliationRowDto>();
    const row = (date: Date, method: PaymentMethod) => {
      const id = key(date, method);
      let found = rows.get(id);
      if (!found) {
        found = {
          businessDate: fromDate(date), method, count: 0, receivedPaise: 0, refundedPaise: 0, netPaise: 0, settledPaise: null, differencePaise: null,
          note: null, reconciledByName: null, reconciledAt: null, changedSince: false,
        };
        rows.set(id, found);
      }
      return found;
    };
    for (const entry of received) Object.assign(row(entry.businessDate, entry.method), { count: entry._count, receivedPaise: entry._sum.amountPaise ?? 0 });
    for (const entry of refunded) row(entry.businessDate, entry.method).refundedPaise = entry._sum.amountPaise ?? 0;
    for (const entry of entries) {
      Object.assign(row(entry.businessDate, entry.method), {
        settledPaise: entry.settledPaise, note: entry.note, reconciledByName: names.get(entry.reconciledById) ?? 'Unknown', reconciledAt: entry.reconciledAt.toISOString(),
      });
    }
    const recorded = new Map(entries.map((entry) => [key(entry.businessDate, entry.method), entry.recordedPaise]));
    for (const [id, found] of rows) {
      found.netPaise = found.receivedPaise - found.refundedPaise;
      if (found.settledPaise !== null) {
        found.differencePaise = found.settledPaise - found.netPaise;
        found.changedSince = recorded.get(id) !== found.netPaise;
      }
    }

    const sumWhere = (groups: { registerSessionId: string | null; _sum: { amountPaise: number | null } }[], inRegister: boolean) =>
      groups.filter((group) => (group.registerSessionId !== null) === inRegister).reduce((sum, group) => sum + (group._sum.amountPaise ?? 0), 0);
    return {
      // Newest day first; within a day, methods in their usual order.
      rows: [...rows.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method)),
      cash: {
        inRegistersPaise: sumWhere(cashIn, true) - sumWhere(cashOut, true),
        outsideRegistersPaise: sumWhere(cashIn, false) - sumWhere(cashOut, false),
        registerVariancePaise: sessions.reduce((sum, session) => sum + (session.variancePaise ?? 0), 0),
        registersClosed: sessions.filter((session) => session.status === 'CLOSED').length,
        registersOpen: sessions.filter((session) => session.status === 'OPEN').length,
      },
    };
  }

  async save(auth: AuthContext, input: z.output<typeof saveReconciliationSchema>): Promise<ReconciliationRowDto> {
    const today = (await this.context.load(auth.restaurantId)).businessDate;
    if (input.businessDate > today) throw invalid('DATE_IN_FUTURE', 'That day has not happened yet.');
    const businessDate = asDate(input.businessDate);
    const netPaise = await this.netOf(auth.restaurantId, businessDate, input.method);
    const where = { restaurantId_businessDate_method: { restaurantId: auth.restaurantId, businessDate, method: input.method } };
    const before = await this.prisma.paymentReconciliation.findUnique({ where });
    const data = { recordedPaise: netPaise, settledPaise: input.settledPaise, note: input.note ?? null, reconciledById: auth.userId, reconciledAt: new Date() };
    await this.prisma.paymentReconciliation.upsert({ where, update: data, create: { restaurantId: auth.restaurantId, businessDate, method: input.method, ...data } });
    await this.audit.record(auth, {
      action: 'payment.reconciled', entityType: 'reconciliation', reason: input.note ?? null,
      before: before && { settledPaise: before.settledPaise, recordedPaise: before.recordedPaise },
      after: { businessDate: input.businessDate, method: input.method, recordedPaise: netPaise, settledPaise: input.settledPaise },
    });
    const { rows } = await this.summary(auth, { from: input.businessDate, to: input.businessDate });
    return rows.find((row) => row.method === input.method)!;
  }

  async clear(auth: AuthContext, date: string, method: PaymentMethod): Promise<void> {
    const where = { restaurantId_businessDate_method: { restaurantId: auth.restaurantId, businessDate: asDate(date), method } };
    const before = await this.prisma.paymentReconciliation.findUnique({ where });
    if (!before) throw notFound('Reconciliation entry');
    await this.prisma.paymentReconciliation.delete({ where });
    await this.audit.record(auth, {
      action: 'payment.reconciliation_cleared', entityType: 'reconciliation',
      before: { businessDate: date, method, settledPaise: before.settledPaise, recordedPaise: before.recordedPaise },
    });
  }

  /** The payments behind a figure, newest first. */
  async payments(auth: AuthContext, query: z.output<typeof paymentQuerySchema>): Promise<Page<PaymentListItemDto>> {
    const where: Prisma.PaymentWhereInput = {
      restaurantId: auth.restaurantId, status: 'SUCCESS', businessDate: { gte: asDate(query.from), lte: asDate(query.to) },
      ...(query.method ? { method: query.method } : {}),
      ...(query.registerSessionId ? { registerSessionId: query.registerSessionId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where, include: { invoice: { select: { invoiceNumber: true } } }, orderBy: [{ paidAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
    ]);
    const names = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.receivedById))] } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]),
    );
    return {
      items: rows.map((row) => ({
        id: row.id, invoiceId: row.invoiceId, invoiceNumber: row.invoice.invoiceNumber, businessDate: fromDate(row.businessDate), method: row.method,
        amountPaise: row.amountPaise, refundedPaise: row.refundedPaise, reference: row.reference, receivedByName: names.get(row.receivedById) ?? 'Unknown',
        paidAt: row.paidAt?.toISOString() ?? null, inRegister: row.registerSessionId !== null,
      })),
      total, page: query.page, pageSize: query.pageSize,
    };
  }

  private async netOf(restaurantId: string, businessDate: Date, method: PaymentMethod): Promise<number> {
    const scope = { restaurantId, businessDate, method, status: 'SUCCESS' as const };
    const [received, refunded] = await Promise.all([
      this.prisma.payment.aggregate({ where: scope, _sum: { amountPaise: true } }),
      this.prisma.refund.aggregate({ where: scope, _sum: { amountPaise: true } }),
    ]);
    return (received._sum.amountPaise ?? 0) - (refunded._sum.amountPaise ?? 0);
  }
}
