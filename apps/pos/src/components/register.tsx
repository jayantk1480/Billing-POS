'use client';

import { formatINR } from '@pos/billing-core';
import { Button, cn, Dialog, ErrorState, errorMessage, formatDateTime, inputToPaise, LoadingState, paiseToInput, TextAreaField, TextField, toast, useApi, useAuth } from '@pos/ui';
import { CASH_DENOMINATIONS, type RegisterDetailDto } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Lock, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { METHOD_LABEL } from '@/lib/api';
import { reportError, useApproval } from '@/lib/approval';
import { rememberRegister } from '@/lib/offline-billing';
import { useOutbox } from '@/lib/outbox';
import { usePrintRegisterReport } from '@/lib/printing';

const REGISTER_KEY = ['register'];

/** Lets any part of the billing screen bring up the cash register, for example when cash is refused without one. */
export const useRegisterDialog = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

/** The cash register the signed-in cashier has open, or null. Only asked for by those who may run a register. */
export function useRegister() {
  const api = useApi();
  const { user } = useAuth();
  const allowed = user?.permissions.includes('register.operate') ?? false;
  const query = useQuery({ queryKey: REGISTER_KEY, queryFn: api.registers.current, enabled: allowed, refetchInterval: 60_000 });
  // Remembered, so that cash taken while the server cannot be reached still goes into this register.
  useEffect(() => {
    if (user && query.isSuccess) rememberRegister(user.id, query.data ?? null);
  }, [user, query.isSuccess, query.data]);
  return { allowed, register: query.data ?? null, query };
}

function Figure({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'danger' | 'ok' }) {
  return (
    <div className={cn('flex justify-between gap-3', strong && 'border-t border-line pt-2 text-base font-semibold text-ink-900')}>
      <dt className={strong ? undefined : 'text-ink-500'}>{label}</dt>
      <dd className={cn('tabular-nums', tone === 'danger' && 'text-danger', tone === 'ok' && 'text-green-700')}>{value}</dd>
    </div>
  );
}

/** "Short ₹10.00", "Over ₹5.00" or "Matches": counted cash against what should be in the drawer. */
export function differenceLabel(variancePaise: number): string {
  if (variancePaise === 0) return 'Matches';
  return (variancePaise < 0 ? 'Short ' : 'Over ') + formatINR(Math.abs(variancePaise));
}

function CashFigures({ register }: { register: RegisterDetailDto }) {
  return (
    <dl className="space-y-1 text-sm" aria-label="Cash in the drawer">
      <Figure label="Opening cash" value={formatINR(register.openingCashPaise)} />
      <Figure label="Cash sales" value={formatINR(register.cashSalesPaise)} />
      {register.cashInPaise > 0 && <Figure label="Cash put in" value={formatINR(register.cashInPaise)} />}
      {register.cashOutPaise > 0 && <Figure label="Cash taken out" value={'− ' + formatINR(register.cashOutPaise)} />}
      {register.cashRefundsPaise > 0 && <Figure label="Cash refunds" value={'− ' + formatINR(register.cashRefundsPaise)} />}
      <Figure label="Should be in the drawer" value={formatINR(register.expectedCashPaise)} strong />
    </dl>
  );
}

function OpenForm({ onOpened, onClose }: { onOpened: () => void; onClose: () => void }) {
  const api = useApi();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const paise = amount.trim() === '' ? Number.NaN : inputToPaise(amount);
  const valid = Number.isInteger(paise) && paise >= 0;

  async function open() {
    setBusy(true);
    try {
      await api.registers.open({ openingCashPaise: paise });
      toast.success('Cash register opened with ' + formatINR(paise));
      onOpened();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title="Open cash register" description="Count the cash in the drawer before you start. Cash you take against bills is added to it."
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onClose}>Not now</Button>
          <Button size="touch" disabled={!valid} loading={busy} onClick={() => void open()}>Open register</Button>
        </>
      }
    >
      <TextField label="Cash in the drawer now" prefix="₹" inputMode="decimal" value={amount} onChange={setAmount} autoFocus placeholder="0" hint="Enter 0 if the drawer is empty." />
    </Dialog>
  );
}

function MovementForm({ type, register, onDone, onBack }: { type: 'CASH_IN' | 'CASH_OUT'; register: RegisterDetailDto; onDone: () => void; onBack: () => void }) {
  const api = useApi();
  const approve = useApproval();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const paise = inputToPaise(amount);
  const tooMuch = type === 'CASH_OUT' && Number.isInteger(paise) && paise > register.expectedCashPaise;
  const valid = Number.isInteger(paise) && paise > 0 && !tooMuch && reason.trim().length > 0;
  const out = type === 'CASH_OUT';

  async function save() {
    setBusy(true);
    try {
      await approve((approval) => api.registers.move({ type, amountPaise: paise, reason: reason.trim(), approval }));
      toast.success(formatINR(paise) + (out ? ' taken out of the register' : ' put into the register'));
      onDone();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open onClose={onBack} size="sm" title={out ? 'Take cash out' : 'Put cash in'}
      description={out ? 'For example paying a supplier from the drawer, or sending cash to the bank.' : 'For example change brought from the bank.'}
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onBack}>Back</Button>
          <Button size="touch" disabled={!valid} loading={busy} onClick={() => void save()}>{out ? 'Take out' : 'Put in'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="Amount" prefix="₹" inputMode="decimal" value={amount} onChange={setAmount} autoFocus
          error={tooMuch ? 'Only ' + formatINR(register.expectedCashPaise) + ' should be in the drawer.' : undefined}
        />
        <TextField label="Reason" value={reason} onChange={setReason} placeholder={out ? 'Paid the milk supplier' : 'Change from the bank'} maxLength={200} />
      </div>
    </Dialog>
  );
}

function CloseForm({ register, onClosed, onBack }: { register: RegisterDetailDto; onClosed: (closed: RegisterDetailDto) => void; onBack: () => void }) {
  const api = useApi();
  const [byNotes, setByNotes] = useState(true);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [total, setTotal] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const countOf = (rupees: number) => Number.parseInt(counts[rupees] ?? '', 10) || 0;
  const counted = byNotes ? CASH_DENOMINATIONS.reduce((sum, rupees) => sum + rupees * countOf(rupees) * 100, 0) : inputToPaise(total);
  const valid = Number.isInteger(counted) && counted >= 0 && (byNotes || total.trim() !== '');

  async function close() {
    // Cash taken offline counts in this register only once it has reached the server.
    const waiting = useOutbox.getState().pending;
    if (waiting > 0) return void toast.error(`${waiting} ${waiting === 1 ? 'thing' : 'things'} made offline on this device ${waiting === 1 ? 'has' : 'have'} not been uploaded yet. Close the register once they have.`);
    setBusy(true);
    try {
      const denominations = byNotes ? Object.fromEntries(CASH_DENOMINATIONS.map((rupees) => [String(rupees), countOf(rupees)]).filter(([, count]) => (count as number) > 0)) : undefined;
      onClosed(await api.registers.close(register.id, { countedCashPaise: counted, denominations, notes: notes.trim() || null }));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open onClose={onBack} title="Close cash register" description="Count the cash in the drawer. The register cannot be reopened after it is closed."
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onBack}>Back</Button>
          <Button variant="danger" size="touch" disabled={!valid} loading={busy} onClick={() => void close()}>Close register</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex rounded-xl bg-canvas p-1" role="radiogroup" aria-label="How to enter the count">
          {[{ id: true, label: 'Count notes and coins' }, { id: false, label: 'Enter the total' }].map((option) => (
            <button
              key={option.label} type="button" role="radio" aria-checked={byNotes === option.id} onClick={() => setByNotes(option.id)}
              className={cn('h-10 flex-1 rounded-lg px-2 text-sm font-semibold', byNotes === option.id ? 'bg-surface text-brand-700 shadow-(--shadow-card)' : 'text-ink-700')}
            >
              {option.label}
            </button>
          ))}
        </div>

        {byNotes ? (
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2" aria-label="Notes and coins">
            {CASH_DENOMINATIONS.map((rupees) => (
              <li key={rupees} className="flex items-center gap-2">
                <label htmlFor={'count-' + rupees} className="w-14 shrink-0 text-sm font-medium tabular-nums text-ink-700">₹{rupees}</label>
                <span className="text-ink-300">×</span>
                <input
                  id={'count-' + rupees} type="text" inputMode="numeric" value={counts[rupees] ?? ''} placeholder="0" aria-label={'Number of ₹' + rupees}
                  onChange={(event) => setCounts({ ...counts, [rupees]: event.target.value.replace(/\D/g, '').slice(0, 5) })}
                  className="h-11 w-20 rounded-lg border border-line bg-surface px-3 text-right text-base tabular-nums"
                />
                <span className="flex-1 text-right text-sm tabular-nums text-ink-500">{formatINR(rupees * countOf(rupees) * 100)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <TextField label="Cash counted in the drawer" prefix="₹" inputMode="decimal" value={total} onChange={setTotal} autoFocus />
        )}

        <div className="flex items-end justify-between rounded-xl bg-ink-900 px-5 py-4 text-white">
          <span className="text-sm text-slate-300">Counted</span>
          <span className="text-3xl font-semibold tabular-nums" data-testid="counted-total">{Number.isInteger(counted) ? formatINR(counted) : '—'}</span>
        </div>
        <TextAreaField label="Notes (optional)" value={notes} onChange={setNotes} rows={2} maxLength={300} placeholder="Anything the manager should know about this count" />
      </div>
    </Dialog>
  );
}

function ClosedSummary({ register, onClose }: { register: RegisterDetailDto; onClose: () => void }) {
  const printReport = usePrintRegisterReport();
  const [printing, setPrinting] = useState(false);
  const variance = register.variancePaise ?? 0;
  return (
    <Dialog open onClose={onClose} size="sm" title="Cash register closed">
      <div className="flex flex-col items-center text-center">
        <CheckCircle2 className="size-14 text-ok" />
        <p className={cn('mt-3 text-2xl font-semibold tabular-nums', variance < 0 ? 'text-danger' : 'text-ink-900')} data-testid="register-difference">{differenceLabel(variance)}</p>
      </div>
      <dl className="mt-4 space-y-1 text-sm">
        <Figure label="Should be in the drawer" value={formatINR(register.expectedCashPaise)} />
        <Figure label="Counted" value={formatINR(register.countedCashPaise ?? 0)} />
      </dl>
      <div className="mt-6 grid gap-2">
        <Button variant="secondary" size="touch" loading={printing} onClick={() => { setPrinting(true); void printReport(register.id).finally(() => setPrinting(false)); }}>
          <Printer className="size-5" /> Print report
        </Button>
        <Button size="touch" onClick={onClose} autoFocus>Done</Button>
      </div>
    </Dialog>
  );
}

/** The cashier's cash register: open it, see what should be in the drawer, put cash in or take it out, and close it. */
export function RegisterDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { register, query } = useRegister();
  const printReport = usePrintRegisterReport();
  const [view, setView] = useState<'summary' | 'CASH_IN' | 'CASH_OUT' | 'close'>('summary');
  const [closed, setClosed] = useState<RegisterDetailDto | null>(null);
  const [printing, setPrinting] = useState(false);
  const reload = () => queryClient.invalidateQueries({ queryKey: REGISTER_KEY });

  if (closed) return <ClosedSummary register={closed} onClose={onClose} />;
  if (query.isPending) return <Dialog open onClose={onClose} size="sm" title="Cash register"><LoadingState /></Dialog>;
  if (query.isError) {
    return <Dialog open onClose={onClose} size="sm" title="Cash register"><ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} /></Dialog>;
  }
  if (!register) return <OpenForm onClose={onClose} onOpened={() => { void reload(); onClose(); }} />;
  if (view === 'CASH_IN' || view === 'CASH_OUT') {
    return <MovementForm type={view} register={register} onBack={() => setView('summary')} onDone={() => { void reload(); setView('summary'); }} />;
  }
  if (view === 'close') {
    return <CloseForm register={register} onBack={() => setView('summary')} onClosed={(done) => { setClosed(done); void reload(); }} />;
  }

  return (
    <Dialog
      open onClose={onClose} title="Cash register"
      description={'Opened ' + formatDateTime(register.openedAt) + (register.terminal ? ' · ' + register.terminal.name : '')}
    >
      <div className="space-y-4">
        <CashFigures register={register} />

        {register.takings.length > 0 && (
          <section aria-label="Taken while this register was open">
            <h3 className="text-sm font-semibold text-ink-900">Taken so far</h3>
            <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line text-sm">
              {register.takings.map((entry) => (
                <li key={entry.method} className="flex justify-between gap-3 px-3 py-2">
                  <span className="text-ink-700">{METHOD_LABEL[entry.method] ?? entry.method} · {entry.count} {entry.count === 1 ? 'payment' : 'payments'}</span>
                  <span className="tabular-nums text-ink-900">{formatINR(entry.receivedPaise)}{entry.refundedPaise > 0 && <span className="text-amber-700"> − {formatINR(entry.refundedPaise)}</span>}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {register.movements.length > 0 && (
          <section aria-label="Cash put in and taken out">
            <h3 className="text-sm font-semibold text-ink-900">Cash in and out</h3>
            <ul className="mt-1.5 divide-y divide-line rounded-xl border border-line text-sm">
              {register.movements.map((move) => (
                <li key={move.id} className="flex justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 text-ink-700"><span className="block truncate">{move.reason}</span><span className="block text-xs text-ink-500">{formatDateTime(move.createdAt)} · {move.createdByName}</span></span>
                  <span className={cn('shrink-0 tabular-nums', move.type === 'CASH_OUT' ? 'text-amber-700' : 'text-ink-900')}>{move.type === 'CASH_OUT' ? '− ' : '+ '}{formatINR(move.amountPaise)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button variant="secondary" size="touch" className="px-2! whitespace-nowrap" onClick={() => setView('CASH_IN')}><ArrowDownToLine className="size-5" /> Cash in</Button>
          <Button variant="secondary" size="touch" className="px-2! whitespace-nowrap" onClick={() => setView('CASH_OUT')}><ArrowUpFromLine className="size-5" /> Cash out</Button>
          <Button variant="secondary" size="touch" className="px-2! whitespace-nowrap" loading={printing} onClick={() => { setPrinting(true); void printReport(register.id).finally(() => setPrinting(false)); }}>
            <Printer className="size-5" /> Print report
          </Button>
          <Button variant="danger" size="touch" className="px-2! whitespace-nowrap max-[379px]:text-sm" onClick={() => setView('close')}><Lock className="size-5" /> Close register</Button>
        </div>
      </div>
    </Dialog>
  );
}
