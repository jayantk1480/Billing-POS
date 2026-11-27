'use client';

import { formatINR } from '@pos/billing-core';
import { Badge, Card, CardHeader, cn, customerLabel, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, PageHeader, type Tone, useApi, useAuth, useRealtime } from '@pos/ui';
import type { DashboardDto, InvoiceSummaryDto } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReceiptText, Wallet } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { GettingStarted } from '@/components/getting-started';

const PAYMENT: Record<InvoiceSummaryDto['paymentStatus'], { label: string; tone: Tone }> = {
  UNPAID: { label: 'Unpaid', tone: 'danger' }, PARTIALLY_PAID: { label: 'Part paid', tone: 'warn' }, PAID: { label: 'Paid', tone: 'ok' },
  PARTIALLY_REFUNDED: { label: 'Part refunded', tone: 'warn' }, REFUNDED: { label: 'Refunded', tone: 'neutral' },
};
const METHODS = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };
const longDate = (date: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(date));
const weekday = (date: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(date));
const shortDate = (date: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date));
/** Whole rupees for chart labels, where paise would only add noise. */
const rupees = (paise: number) => formatINR(Math.round(paise / 100) * 100).replace(/\.00$/, '');

/** One headline number with its label and an optional line of context. */
function StatTile({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-ink-500">{label}</p>
      <p className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums text-ink-900">{value}</p>
      {detail && <p className="mt-1.5 text-sm text-ink-500">{detail}</p>}
    </Card>
  );
}

/**
 * Sales for the last seven days as thin columns on one baseline. Today's column carries its value;
 * the rest show theirs on hover or keyboard focus. The same figures are in the Daily sales report.
 */
function SalesTrend({ trend, today }: { trend: DashboardDto['trend']; today: string }) {
  const max = Math.max(...trend.map((day) => day.totalPaise), 1);
  const plotHeight = 160;
  return (
    <figure aria-label="Sales for the last seven days">
      <div className="flex items-end gap-2 border-b border-line px-1" style={{ height: plotHeight + 28 }}>
        {trend.map((day) => {
          const height = Math.round((day.totalPaise / max) * plotHeight);
          const isToday = day.date === today;
          const summary = shortDate(day.date) + ': ' + formatINR(day.totalPaise) + ' from ' + day.bills + (day.bills === 1 ? ' bill' : ' bills');
          return (
            <div key={day.date} tabIndex={0} aria-label={summary} className="group relative flex h-full flex-1 cursor-default flex-col items-center justify-end rounded-md outline-offset-2">
              <span className="pointer-events-none absolute -top-1 z-10 hidden whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-xs text-white shadow-lg group-hover:block group-focus-visible:block">
                {summary}
              </span>
              {isToday && day.totalPaise > 0 && <span className="mb-1 text-xs font-medium tabular-nums text-ink-900">{rupees(day.totalPaise)}</span>}
              <span
                className={cn('w-full max-w-6 rounded-t bg-chart-1 transition-opacity group-hover:opacity-80', day.totalPaise === 0 && 'bg-line')}
                style={{ height: Math.max(height, 2) }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-2 px-1">
        {trend.map((day) => (
          <span key={day.date} className={cn('flex-1 text-center text-xs', day.date === today ? 'font-medium text-ink-900' : 'text-ink-500')}>
            {day.date === today ? 'Today' : weekday(day.date)}
          </span>
        ))}
      </div>
    </figure>
  );
}

/** Money received today by method: horizontal bars from a shared baseline, value at the tip. */
function PaymentBars({ payments }: { payments: DashboardDto['payments'] }) {
  const max = Math.max(...payments.map((payment) => payment.amountPaise), 1);
  if (payments.length === 0) return <p className="px-5 py-10 text-center text-sm text-ink-500">No payments yet today.</p>;
  return (
    <ul className="space-y-4 p-5">
      {payments.map((payment) => (
        <li key={payment.method} title={payment.count + (payment.count === 1 ? ' payment' : ' payments')}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-ink-700">{METHODS[payment.method]}</span>
            <span className="font-medium tabular-nums text-ink-900">{formatINR(payment.amountPaise)}</span>
          </div>
          <div className="mt-1.5 h-2 rounded-r bg-canvas">
            <div className="h-2 rounded-r bg-chart-1" style={{ width: Math.max((payment.amountPaise / max) * 100, 1) + '%' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Every cash register that is open right now, with the cash that should be in its drawer. For people who may see all registers. */
function OpenRegisters() {
  const api = useApi();
  const registers = useQuery({ queryKey: ['registers', 'open-now'], queryFn: () => api.registers.list({ status: 'OPEN', pageSize: 50 }), refetchInterval: 30_000 });
  return (
    <Card className="mt-6">
      <CardHeader
        title="Cash registers open now" description="The cash that should be in each drawer at this moment"
        action={<Link href="/sales/registers" className="text-sm font-medium text-brand-700 hover:underline">All cash registers</Link>}
      />
      {registers.isPending ? (
        <LoadingState label="Loading cash registers" />
      ) : registers.isError ? (
        <ErrorState message={errorMessage(registers.error)} onRetry={() => void registers.refetch()} />
      ) : registers.data.items.length === 0 ? (
        <EmptyState icon={Wallet} title="No register is open" description="A cash register appears here when a cashier opens one on the billing screen." />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {registers.data.items.map((register) => (
              <li key={register.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink-900">{register.user.name}</span>
                  <span className="block truncate text-xs text-ink-500">{register.terminal ? register.terminal.name : 'No terminal'} · opened {formatDateTime(register.openedAt)}</span>
                </span>
                <span className="text-right">
                  <span className="block font-medium tabular-nums text-ink-900">{formatINR(register.expectedCashPaise)}</span>
                  <span className="block text-xs text-ink-500">expected in the drawer</span>
                </span>
              </li>
            ))}
          </ul>
          {registers.data.total > registers.data.items.length && (
            <p className="border-t border-line px-5 py-3 text-sm text-ink-500">Showing {registers.data.items.length} of {registers.data.total} open registers.</p>
          )}
        </>
      )}
    </Card>
  );
}

export default function DashboardPage() {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 30_000 });
  useRealtime((event) => {
    if (event === 'invoice.updated' || event === 'order.updated') void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    // A payment changes the cash expected in an open register, so bills refresh the registers too.
    if (event === 'register.updated' || event === 'invoice.updated') void queryClient.invalidateQueries({ queryKey: ['registers'] });
  });

  if (dashboard.isPending) return <Card><LoadingState label="Loading today's figures" /></Card>;
  if (dashboard.isError) return <Card><ErrorState message={errorMessage(dashboard.error)} onRetry={() => void dashboard.refetch()} /></Card>;
  const data = dashboard.data;
  const { sales, orders, unpaid } = data;

  return (
    <>
      <PageHeader title="Today" description={longDate(data.businessDate) + '. Figures update as bills are issued and paid.'} />
      <GettingStarted />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Net sales" value={formatINR(sales.netPaise)}
          detail={sales.refundsPaise > 0 ? formatINR(sales.totalPaise) + ' billed, ' + formatINR(sales.refundsPaise) + ' refunded' : 'Completed orders today, tax included'}
        />
        <StatTile label="Bills" value={String(sales.bills)} detail={orders.taken + ' orders taken, ' + orders.running + ' still running'} />
        <StatTile label="Average bill" value={formatINR(sales.averagePaise)} detail={sales.discountPaise > 0 ? formatINR(sales.discountPaise) + ' given in discounts' : 'No discounts today'} />
        <StatTile
          label="Awaiting payment" value={formatINR(unpaid.amountPaise)}
          detail={unpaid.bills === 0 ? 'Every bill is paid' : unpaid.bills + (unpaid.bills === 1 ? ' bill is unpaid' : ' bills are unpaid')}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Sales, last 7 days" description="Billed total for each business day"
            action={can('report.view') && <Link href="/reports" className="text-sm font-medium text-brand-700 hover:underline">View as a table</Link>}
          />
          <div className="p-5 pt-8"><SalesTrend trend={data.trend} today={data.businessDate} /></div>
        </Card>
        <Card>
          <CardHeader title="Payments today" description="Money received, by method" />
          <PaymentBars payments={data.payments} />
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Top items today" description="By quantity sold" />
          {data.topItems.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-500">Nothing sold yet today.</p>
          ) : (
            <ol className="divide-y divide-line">
              {data.topItems.map((item, index) => (
                <li key={item.name} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <span className="w-4 text-ink-500">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{item.name}</span>
                  <span className="tabular-nums text-ink-500">{item.quantity} sold</span>
                  <span className="w-24 text-right tabular-nums text-ink-900">{formatINR(item.totalPaise)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent bills"
            action={can('order.view_all') && <Link href="/sales/invoices" className="text-sm font-medium text-brand-700 hover:underline">All bills</Link>}
          />
          {data.recentBills.length === 0 ? (
            <EmptyState icon={ReceiptText} title="No bills yet" description="Bills appear here as they are issued on the POS." />
          ) : (
            <ul className="divide-y divide-line">
              {data.recentBills.map((bill) => {
                const status = bill.status === 'CANCELLED' ? { label: 'Cancelled', tone: 'neutral' as Tone } : PAYMENT[bill.paymentStatus];
                return (
                  <li key={bill.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink-900">{bill.invoiceNumber}</span>
                      <span className="block truncate text-xs text-ink-500">{formatDateTime(bill.issuedAt)} · {bill.cashierName}{(bill.customerPhone || bill.customerName) && ' · ' + customerLabel(bill.customerPhone, bill.customerName)}</span>
                    </span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="w-24 text-right font-medium tabular-nums text-ink-900">{formatINR(bill.totalPaise)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {can('register.view_all') && <OpenRegisters />}
    </>
  );
}
