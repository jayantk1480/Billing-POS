'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, cn, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, inputToPaise, LoadingState, PageHeader, Table, Td,
  TextAreaField, TextField, Th, toast, useApi, useAuth, useFormState, useRealtime, useSorted, useSorter,
} from '@pos/ui';
import { CASH_DENOMINATIONS, closeRegisterSchema, type PaymentMethod, type RegisterDetailDto, type RegisterQuery } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Printer, Wallet } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Difference, differenceText } from '@/components/difference';
import { Pager } from '@/components/pager';
import { addDays, todayIso } from '@/lib/dates';

const PAGE_SIZE = 25;
const METHODS: Record<PaymentMethod, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };
type Status = 'OPEN' | 'CLOSED';

/** Counting the drawer: one total, or how many of each note and coin. */
function CloseForm({ register, onDone, onCancel }: { register: RegisterDetailDto; onDone: (closed: RegisterDetailDto) => void; onCancel: () => void }) {
  const api = useApi();
  const form = useFormState({ byNote: false, amount: '', counts: {} as Record<string, string>, notes: '' });
  const { values, set, errors } = form;
  const countOf = (rupees: number) => Number(values.counts[String(rupees)] || 0);
  const counted = values.byNote ? CASH_DENOMINATIONS.reduce((sum, rupees) => sum + rupees * 100 * countOf(rupees), 0) : inputToPaise(values.amount);
  const entered = values.byNote || values.amount.trim() !== '';
  const usable = Number.isInteger(counted) && counted >= 0;
  const countError = Object.entries(errors).find(([key]) => key.startsWith('denominations'))?.[1];

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const denominations = values.byNote
      ? Object.fromEntries(CASH_DENOMINATIONS.filter((rupees) => countOf(rupees) > 0).map((rupees) => [String(rupees), countOf(rupees)]))
      : undefined;
    await form.submit(closeRegisterSchema, { countedCashPaise: counted, denominations, notes: values.notes }, async (data) => {
      onDone(await api.registers.close(register.id, data));
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-line bg-canvas p-4">
      <p className="text-sm font-semibold text-ink-900">Close register</p>
      <p className="text-ink-700">Count the cash in the drawer. It should come to <span className="font-medium tabular-nums text-ink-900">{formatINR(register.expectedCashPaise)}</span>.</p>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How to enter the cash counted">
        {[{ byNote: false, label: 'Enter the total' }, { byNote: true, label: 'Count notes and coins' }].map((choice) => (
          <button
            key={choice.label} type="button" role="radio" aria-checked={values.byNote === choice.byNote} onClick={() => set('byNote', choice.byNote)}
            className={cn('h-10 rounded-lg border bg-surface px-3 text-sm font-medium text-ink-900', values.byNote === choice.byNote ? 'border-brand-600 ring-1 ring-brand-600' : 'border-line')}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {values.byNote ? (
        <div>
          <ul className="grid gap-2 sm:grid-cols-2" aria-label="Notes and coins">
            {CASH_DENOMINATIONS.map((rupees) => (
              <li key={rupees} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
                <label htmlFor={`count-${rupees}`} className="w-12 text-sm font-medium tabular-nums text-ink-900">₹{rupees}</label>
                <span className="text-ink-500" aria-hidden>×</span>
                <input
                  id={`count-${rupees}`} inputMode="numeric" placeholder="0" maxLength={6} value={values.counts[String(rupees)] ?? ''}
                  onChange={(event) => set('counts', { ...values.counts, [String(rupees)]: event.target.value.replace(/\D/g, '') })}
                  className="h-8 w-20 rounded-lg border border-line bg-surface px-2 text-right text-sm tabular-nums text-ink-900 placeholder:text-ink-300"
                />
                <span className="ml-auto text-sm tabular-nums text-ink-500">{formatINR(rupees * 100 * countOf(rupees))}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex justify-between text-base font-semibold text-ink-900" aria-live="polite"><span>Cash counted</span><span className="tabular-nums">{formatINR(counted)}</span></p>
          {(countError ?? errors.countedCashPaise) && <p role="alert" className="mt-1 text-xs text-danger">{countError ?? errors.countedCashPaise}</p>}
        </div>
      ) : (
        <TextField label="Cash counted" prefix="₹" inputMode="decimal" value={values.amount} onChange={(v) => set('amount', v)} error={errors.countedCashPaise} autoFocus />
      )}
      {entered && usable && (
        <p className="flex justify-between text-ink-700" aria-live="polite"><span>Difference</span><Difference paise={counted - register.expectedCashPaise} /></p>
      )}
      <TextAreaField label="Notes" value={values.notes} onChange={(v) => set('notes', v)} error={errors.notes} rows={2} maxLength={300} placeholder="Optional, for example why the cash is short" />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={form.submitting}>Back</Button>
        <Button type="submit" loading={form.submitting}>Close register</Button>
      </div>
    </form>
  );
}

function RegisterDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const register = useQuery({ queryKey: ['register', id], queryFn: () => api.registers.get(id) });
  const [closing, setClosing] = useState(false);
  const [justClosed, setJustClosed] = useState(false);
  const print = useMutation({
    mutationFn: () => api.registers.print(id),
    onSuccess: () => toast.success('Register report sent to the printer'),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const data = register.data;
  const takings = useSorted(data?.takings, {
    method: (taking) => METHODS[taking.method], count: (taking) => taking.count, received: (taking) => taking.receivedPaise,
    refunded: (taking) => taking.refundedPaise, net: (taking) => taking.receivedPaise - taking.refundedPaise,
  });
  const counts = data?.denominations ? CASH_DENOMINATIONS.map((rupees) => ({ rupees, count: data.denominations?.[String(rupees)] ?? 0 })).filter((entry) => entry.count > 0) : [];
  const row = (label: string, value: string, strong = false) => (
    <div className={cn('flex justify-between', strong && 'border-t border-line pt-2 text-base font-semibold text-ink-900')}><dt className={strong ? undefined : 'text-ink-500'}>{label}</dt><dd className="tabular-nums">{value}</dd></div>
  );

  return (
    <Dialog
      open onClose={onClose} size="lg" title={data ? `Cash register · ${data.user.name}` : 'Cash register'}
      description={data ? `${data.terminal ? `${data.terminal.name} (${data.terminal.code})` : 'No terminal'} · opened ${formatDateTime(data.openedAt)}${data.closedAt ? ` · closed ${formatDateTime(data.closedAt)}${data.closedByName ? ` by ${data.closedByName}` : ''}` : ' · still open'}` : undefined}
    >
      {register.isPending ? <LoadingState /> : register.isError || !data ? <ErrorState message={errorMessage(register.error)} onRetry={() => void register.refetch()} /> : (
        <div className="space-y-5 text-sm">
          {justClosed && data.variancePaise !== null && (
            <p role="status" className={cn('rounded-lg px-3 py-2.5 font-medium', data.variancePaise < 0 ? 'bg-red-50 text-red-700' : data.variancePaise > 0 ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700')}>
              Register closed. {data.variancePaise === 0 ? 'The cash counted matches what was expected.' : `${differenceText(data.variancePaise)} against the ${formatINR(data.expectedCashPaise)} expected.`}
            </p>
          )}
          <dl className="space-y-1">
            {row('Opening cash', formatINR(data.openingCashPaise))}
            {row('Cash sales', formatINR(data.cashSalesPaise))}
            {row('Cash put in', formatINR(data.cashInPaise))}
            {row('Cash taken out', `− ${formatINR(data.cashOutPaise)}`)}
            {row('Cash refunds', `− ${formatINR(data.cashRefundsPaise)}`)}
            {row(data.status === 'OPEN' ? 'Expected in the drawer now' : 'Expected in the drawer', formatINR(data.expectedCashPaise), true)}
            {data.countedCashPaise !== null && row('Cash counted', formatINR(data.countedCashPaise))}
            {data.variancePaise !== null && <div className="flex justify-between"><dt className="text-ink-500">Difference</dt><dd><Difference paise={data.variancePaise} /></dd></div>}
          </dl>

          <section aria-label="Takings by payment method">
            <h3 className="mb-2 font-semibold text-ink-900">Takings by payment method</h3>
            {data.takings.length === 0 ? <p className="text-ink-500">No payments were taken while this register was open.</p> : (
              <div className="overflow-hidden rounded-xl border border-line">
                <Table>
                  <thead>
                    <tr>
                      <Th sorter={takings.sorter} sortKey="method">Method</Th><Th sorter={takings.sorter} sortKey="count" className="text-right">Payments</Th>
                      <Th sorter={takings.sorter} sortKey="received" className="text-right">Received</Th><Th sorter={takings.sorter} sortKey="refunded" className="text-right">Refunded</Th>
                      <Th sorter={takings.sorter} sortKey="net" className="text-right">Net</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {takings.rows.map((taking) => (
                      <tr key={taking.method}>
                        <Td className="text-ink-900">{METHODS[taking.method]}</Td>
                        <Td className="text-right tabular-nums">{taking.count}</Td>
                        <Td className="text-right tabular-nums">{formatINR(taking.receivedPaise)}</Td>
                        <Td className="text-right tabular-nums">{formatINR(taking.refundedPaise)}</Td>
                        <Td className="text-right font-medium tabular-nums text-ink-900">{formatINR(taking.receivedPaise - taking.refundedPaise)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            <p className="mt-1.5 text-xs text-ink-500">Only cash is kept in the drawer. The other methods are shown so the whole shift can be checked.</p>
          </section>

          <section aria-label="Cash put in and taken out">
            <h3 className="mb-2 font-semibold text-ink-900">Cash put in and taken out</h3>
            {data.movements.length === 0 ? <p className="text-ink-500">No cash was put in or taken out.</p> : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {data.movements.map((movement) => (
                  <li key={movement.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-ink-900">{movement.type === 'CASH_IN' ? 'Cash put in' : 'Cash taken out'}{movement.reason && <span className="text-ink-700"> · {movement.reason}</span>}</span>
                      <span className="block text-xs text-ink-500">{movement.createdByName} · {formatDateTime(movement.createdAt)}</span>
                    </span>
                    <span className="whitespace-nowrap tabular-nums text-ink-900">{movement.type === 'CASH_IN' ? '+ ' : '− '}{formatINR(movement.amountPaise)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {counts.length > 0 && (
            <section aria-label="Notes and coins counted">
              <h3 className="mb-2 font-semibold text-ink-900">Notes and coins counted</h3>
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {counts.map((entry) => (
                  <li key={entry.rupees} className="flex justify-between">
                    <span className="tabular-nums text-ink-700">₹{entry.rupees} × {entry.count}</span>
                    <span className="tabular-nums text-ink-900">{formatINR(entry.rupees * 100 * entry.count)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.closingNotes && <p className="text-ink-700">Closing notes: <span className="text-ink-900">{data.closingNotes}</span></p>}
          {data.status === 'CLOSED' && <p className="text-ink-700">Closed by <span className="font-medium text-ink-900">{data.closedByName ?? 'Unknown'}</span>{data.closedAt && ` on ${formatDateTime(data.closedAt)}`}</p>}

          {closing && data.status === 'OPEN' ? (
            <CloseForm
              register={data} onCancel={() => setClosing(false)}
              onDone={(closed) => {
                queryClient.setQueryData(['register', id], closed);
                void queryClient.invalidateQueries({ queryKey: ['registers'] });
                // Cash totals on the reconciliation page count closed and open registers.
                void queryClient.invalidateQueries({ queryKey: ['reconciliation'] });
                setClosing(false);
                setJustClosed(true);
                toast.success(closed.variancePaise ? `Register closed. ${differenceText(closed.variancePaise)}.` : 'Register closed. The cash matches.');
              }}
            />
          ) : (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Button variant="secondary" loading={print.isPending} onClick={() => print.mutate()}><Printer className="size-4" /> Print report</Button>
              {data.status === 'OPEN' && can('register.view_all') && <Button onClick={() => setClosing(true)}>Close register</Button>}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export default function RegistersPage() {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const seesAll = can('register.view_all');
  const [from, setFrom] = useState(() => addDays(todayIso(), -6));
  const [to, setTo] = useState(todayIso);
  const [status, setStatus] = useState<Status | ''>('');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);

  // Sorting is done by the server, across every page of the list, so a new sort starts again from page one.
  const sorter = useSorter(null, () => setPage(1));
  const filters = {
    from: from || undefined, to: to || undefined, status: status || undefined, userId: userId || undefined, page, pageSize: PAGE_SIZE,
    sort: sorter.state?.key as RegisterQuery['sort'], direction: sorter.state?.direction,
  };
  const registers = useQuery({ queryKey: ['registers', filters], queryFn: () => api.registers.list(filters), placeholderData: keepPreviousData });
  // A register left open on an earlier day would otherwise be hidden by the dates.
  const earlier = useQuery({
    queryKey: ['registers', 'open-before', from], queryFn: () => api.registers.list({ status: 'OPEN', to: addDays(from, -1), pageSize: 1 }), enabled: Boolean(from),
  });
  const openEarlier = from ? earlier.data?.total ?? 0 : 0;
  // The list of people is only readable by someone who manages users; without it there is no cashier filter.
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list, enabled: seesAll && can('users.manage') });
  useRealtime((event) => {
    // A payment changes the cash expected in an open register, so bills refresh the list too.
    if (event !== 'register.updated' && event !== 'invoice.updated') return;
    void queryClient.invalidateQueries({ queryKey: ['registers'] });
    void queryClient.invalidateQueries({ queryKey: ['register'] });
  });

  const total = registers.data?.total ?? 0;
  const control = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';
  const none = <span className="text-ink-300">—</span>;

  return (
    <>
      <PageHeader
        title="Cash registers"
        description={seesAll
          ? 'Each time a cashier opens and closes the cash drawer. The difference is the cash counted less the cash that should have been there.'
          : 'Each time you opened and closed the cash drawer. The difference is the cash counted less the cash that should have been there.'}
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <label className="flex items-center gap-2 text-sm text-ink-500">From <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className={control} /></label>
          <label className="flex items-center gap-2 text-sm text-ink-500">To <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className={control} /></label>
          <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value as Status | ''); setPage(1); }} className={control}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="CLOSED">Closed</option>
          </select>
          {users.data && (
            <select aria-label="Filter by cashier" value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }} className={control}>
              <option value="">Any cashier</option>
              {users.data.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
            </select>
          )}
        </div>
        {openEarlier > 0 && (
          <p role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
            <span>{openEarlier === 1 ? '1 cash register opened before these dates is still open.' : `${openEarlier} cash registers opened before these dates are still open.`}</span>
            <Button variant="secondary" size="sm" onClick={() => { setFrom(''); setStatus('OPEN'); setUserId(''); setPage(1); }}>Show every open register</Button>
          </p>
        )}
        {registers.isPending ? <LoadingState label="Loading cash registers" /> : registers.isError ? <ErrorState message={errorMessage(registers.error)} onRetry={() => void registers.refetch()} /> : registers.data.items.length === 0 ? (
          <EmptyState icon={Wallet} title="No cash registers match" description="Change the dates or filters. A cash register is opened and closed on the billing screen." />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th sorter={sorter} sortKey="opened">Opened</Th><Th sorter={sorter} sortKey="closed">Closed</Th><Th sorter={sorter} sortKey="cashier">Cashier</Th>
                  <Th sorter={sorter} sortKey="terminal">Terminal</Th><Th sorter={sorter} sortKey="opening" className="text-right">Opening cash</Th>
                  <Th sorter={sorter} sortKey="expected" className="text-right">Expected</Th><Th sorter={sorter} sortKey="counted" className="text-right">Counted</Th>
                  <Th sorter={sorter} sortKey="variance" className="text-right">Difference</Th><Th sorter={sorter} sortKey="status">Status</Th>
                  <Th className="w-0"><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {registers.data.items.map((register) => (
                  <tr key={register.id} className="hover:bg-canvas/50">
                    <Td className="whitespace-nowrap"><button type="button" onClick={() => setViewing(register.id)} className="font-medium text-brand-700 hover:underline">{formatDateTime(register.openedAt)}</button></Td>
                    <Td className="whitespace-nowrap">{register.closedAt ? formatDateTime(register.closedAt) : none}</Td>
                    <Td>{register.user.name}</Td>
                    <Td>{register.terminal ? register.terminal.name : none}</Td>
                    <Td className="text-right tabular-nums">{formatINR(register.openingCashPaise)}</Td>
                    <Td className="text-right tabular-nums">{formatINR(register.expectedCashPaise)}</Td>
                    <Td className="text-right tabular-nums text-ink-900">{register.countedCashPaise === null ? none : formatINR(register.countedCashPaise)}</Td>
                    <Td className="text-right">{register.variancePaise === null ? none : <Difference paise={register.variancePaise} />}</Td>
                    <Td><Badge tone={register.status === 'OPEN' ? 'warn' : 'neutral'}>{register.status === 'OPEN' ? 'Open' : 'Closed'}</Badge></Td>
                    <Td>
                      <button type="button" aria-label={`View ${register.user.name}'s register opened ${formatDateTime(register.openedAt)}`} title="View" onClick={() => setViewing(register.id)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                        <Eye className="size-4" />
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
          </>
        )}
      </Card>
      {viewing && <RegisterDialog id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
