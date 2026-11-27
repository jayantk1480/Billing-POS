'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, PageHeader, Table, Td, Th, type Tone, useApi, useSorter,
} from '@pos/ui';
import type { CustomerQuery, OrderStatus } from '@pos/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Contact } from 'lucide-react';
import { useState } from 'react';

const PAGE_SIZE = 25;
const STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'warn' }, HELD: { label: 'On hold', tone: 'neutral' }, BILLED: { label: 'Awaiting payment', tone: 'danger' },
  SETTLED: { label: 'Settled', tone: 'ok' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' }, MERGED: { label: 'Merged', tone: 'neutral' },
};
const TYPES = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** One customer, by their mobile number: their details and every order taken for them, with its bill and amount. */
function CustomerDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi();
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => api.customers.get(id) });
  const data = customer.data;
  return (
    <Dialog
      open onClose={onClose} size="lg" title={data?.phone ?? 'Customer'}
      description={data ? [data.name, data.address].filter(Boolean).join(' · ') || 'No name on record' : undefined}
    >
      {customer.isPending ? <LoadingState /> : customer.isError || !data ? <ErrorState message={errorMessage(customer.error)} onRetry={() => void customer.refetch()} /> : (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-3 gap-3 rounded-xl bg-canvas p-3">
            <div><dt className="text-xs text-ink-500">Orders</dt><dd className="text-lg font-semibold tabular-nums text-ink-900">{data.orderCount}</dd></div>
            <div><dt className="text-xs text-ink-500">Spent</dt><dd className="text-lg font-semibold tabular-nums text-ink-900">{formatINR(data.spentPaise)}</dd></div>
            <div><dt className="text-xs text-ink-500">Last order</dt><dd className="font-medium text-ink-900">{data.lastOrderAt ? formatDateTime(data.lastOrderAt) : '—'}</dd></div>
          </dl>
          {data.orders.length === 0 ? <p className="text-ink-500">No orders yet.</p> : (
            <Table>
              <thead>
                <tr><Th>Order</Th><Th>Date</Th><Th>Bill</Th><Th className="text-right">Amount</Th><Th>Status</Th></tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.id}>
                    <Td className="font-medium text-ink-900">{order.displayNumber}<span className="block text-xs font-normal text-ink-500">{TYPES[order.type]}</span></Td>
                    <Td className="whitespace-nowrap">{formatDateTime(order.createdAt)}</Td>
                    <Td className="whitespace-nowrap">{order.invoiceNumbers.join(', ') || <span className="text-ink-300">Not billed</span>}</Td>
                    <Td className="text-right tabular-nums text-ink-900">
                      {formatINR(order.totalPaise)}
                      {order.status === 'BILLED' && order.paidPaise > 0 && <span className="block text-xs text-ink-500">{formatINR(order.paidPaise)} paid</span>}
                    </Td>
                    <Td><Badge tone={STATUS[order.status].tone}>{STATUS[order.status].label}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="text-xs text-ink-500">Spent counts settled orders only. Orders cancelled or merged into another order are listed but not counted.</p>
        </div>
      )}
    </Dialog>
  );
}

export default function CustomersPage() {
  const api = useApi();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);
  // Sorting is done by the server, across every page of the list, so a new sort starts again from page one.
  const sorter = useSorter(null, () => setPage(1));
  const filters = { search: search.trim() || undefined, page, pageSize: PAGE_SIZE, sort: sorter.state?.key as CustomerQuery['sort'], direction: sorter.state?.direction };
  const customers = useQuery({ queryKey: ['customers', filters], queryFn: () => api.customers.list(filters), placeholderData: keepPreviousData });
  const total = customers.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Customers" description="Everyone named on an order at the counter, by mobile number: one number is one customer." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <input
            type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Mobile number or name" aria-label="Search customers"
            className="h-10 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700"
          />
        </div>
        {customers.isPending ? <LoadingState label="Loading customers" /> : customers.isError ? <ErrorState message={errorMessage(customers.error)} onRetry={() => void customers.refetch()} /> : customers.data.items.length === 0 ? (
          <EmptyState icon={Contact} title={search ? 'No customers match' : 'No customers yet'} description={search ? 'Try another number or name.' : 'Customers are added from the Customer button on the billing screen, by mobile number.'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th sorter={sorter} sortKey="phone">Mobile</Th><Th sorter={sorter} sortKey="name">Name</Th>
                  <Th sorter={sorter} sortKey="orders" className="text-right">Orders</Th><Th sorter={sorter} sortKey="spent" className="text-right">Spent</Th>
                  <Th sorter={sorter} sortKey="lastOrder">Last order</Th>
                </tr>
              </thead>
              <tbody>
                {customers.data.items.map((customer) => (
                  <tr key={customer.id} className="hover:bg-canvas/50">
                    <Td className="whitespace-nowrap">
                      <button type="button" onClick={() => setViewing(customer.id)} className="font-medium tabular-nums text-brand-700 hover:underline">{customer.phone}</button>
                    </Td>
                    <Td>
                      {customer.name ?? <span className="text-ink-300">—</span>}
                      {customer.address && <span className="block max-w-xs truncate text-xs text-ink-500">{customer.address}</span>}
                    </Td>
                    <Td className="text-right tabular-nums">{customer.orderCount}</Td>
                    <Td className="text-right font-medium tabular-nums text-ink-900">{formatINR(customer.spentPaise)}</Td>
                    <Td className="whitespace-nowrap">{customer.lastOrderAt ? formatDateTime(customer.lastOrderAt) : <span className="text-ink-300">—</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-500">
              <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</span>
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
                <span className="px-2 tabular-nums">{page} / {pageCount}</span>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
              </div>
            </div>
          </>
        )}
      </Card>
      {viewing && <CustomerDialog id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
