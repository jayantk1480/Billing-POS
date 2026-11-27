'use client';

import { ApiRequestError } from '@pos/api-client';
import { allocate, formatINR } from '@pos/billing-core';
import { Button, cn, Dialog, inputToPaise, paiseToInput, TextField, useApi } from '@pos/ui';
import type { InvoiceDto, PaymentMethod } from '@pos/validation';
import { CheckCircle2, Minus, Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { reportError } from '@/lib/approval';
import type { CartLine } from '@/lib/cart';
import { useLocalPrinter } from '@/lib/local-printer';
import { isMadeOffline } from '@/lib/offline-billing';
import { usePrintBill } from '@/lib/printing';
import { useRegisterDialog } from './register';

const METHODS: { id: PaymentMethod; label: string }[] = [{ id: 'CASH', label: 'Cash' }, { id: 'UPI', label: 'UPI' }, { id: 'CARD', label: 'Card' }, { id: 'OTHER', label: 'Other' }];

interface Tender {
  id: string;
  method: PaymentMethod;
  amount: string;
  received: string;
  reference: string;
}

const tender = (amountPaise: number, method: PaymentMethod = 'CASH'): Tender => ({
  id: crypto.randomUUID(), method, amount: paiseToInput(amountPaise), received: '', reference: '',
});

/** The payments being recorded, as the API takes them. */
export type TenderInput = { id: string; method: PaymentMethod; amountPaise: number; tenderedPaise?: number; reference: string | null };

/**
 * Takes payment for one or more bills, one after another. A bill can be paid by several tenders,
 * and in parts: the dialog stays on a bill until nothing is due on it. With `autoPrint`, each bill
 * not printed yet prints by itself the moment nothing more is due. A bill made on this device offline
 * is paid through `payOffline`, which keeps the payments for upload.
 */
export function PayDialog({ invoices, autoPrint, onFinished, payOffline }: {
  invoices: InvoiceDto[]; autoPrint?: boolean; onFinished: () => void; payOffline?: (invoice: InvoiceDto, payments: TenderInput[]) => Promise<InvoiceDto>;
}) {
  const api = useApi();
  const print = usePrintBill();
  const [bills, setBills] = useState(invoices);
  const index = bills.findIndex((bill) => bill.totalPaise - bill.paidPaise > 0);
  const current = index >= 0 ? bills[index]! : null;
  const due = current ? current.totalPaise - current.paidPaise : 0;
  const [tenders, setTenders] = useState<Tender[]>(() => [tender(due)]);
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState(0);

  const localPrinter = useLocalPrinter((state) => state.printer);
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (current || !autoPrint || autoPrinted.current) return;
    autoPrinted.current = true;
    const unprinted = bills.filter((bill) => bill.printCount === 0);
    // The browser's print dialog shows one printout at a time, so without a connected printer
    // only the first bill of a split prints by itself; the buttons below cover the rest.
    for (const bill of localPrinter ? unprinted : unprinted.slice(0, 1)) print(bill);
  }, [current, autoPrint, bills, print, localPrinter]);

  const amounts = tenders.map((t) => inputToPaise(t.amount));
  const valid = amounts.every((amount) => Number.isInteger(amount) && amount > 0);
  const entered = valid ? amounts.reduce((a, b) => a + b, 0) : 0;
  const remaining = due - entered;
  const update = (id: string, patch: Partial<Tender>) => setTenders(tenders.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // Cash handed over must cover the cash amount; anything above it is change.
  const cashProblem = tenders.some((t, i) => t.method === 'CASH' && t.received.trim() !== '' && !(inputToPaise(t.received) >= amounts[i]!));

  async function confirm() {
    if (!current) return;
    setBusy(true);
    try {
      const payments: TenderInput[] = tenders.map((t, i) => {
        const received = t.method === 'CASH' && t.received.trim() ? inputToPaise(t.received) : undefined;
        return { id: t.id, method: t.method, amountPaise: amounts[i]!, tenderedPaise: received, reference: t.reference.trim() || null };
      });
      const paid = isMadeOffline(current.id) && payOffline ? await payOffline(current, payments) : await api.invoices.pay(current.id, payments);
      const next = bills.map((bill) => (bill.id === paid.id ? paid : bill));
      setBills(next);
      setChange(change + tenders.reduce((sum, t, i) => sum + (t.method === 'CASH' && t.received.trim() ? inputToPaise(t.received) - amounts[i]! : 0), 0));
      const nextDue = next.find((bill) => bill.totalPaise - bill.paidPaise > 0);
      if (nextDue) setTenders([tender(nextDue.totalPaise - nextDue.paidPaise)]);
    } catch (error) {
      reportError(error);
      // Cash needs an open register here: bring the register up so it can be opened and the payment tried again.
      if (error instanceof ApiRequestError && error.code === 'REGISTER_NOT_OPEN') useRegisterDialog.getState().show();
    } finally {
      setBusy(false);
    }
  }

  if (!current) {
    return (
      <Dialog open onClose={onFinished} size="sm" title="Payment complete">
        <div className="flex flex-col items-center py-2 text-center">
          <CheckCircle2 className="size-14 text-ok" />
          <p className="mt-3 text-2xl font-semibold tabular-nums text-ink-900">{formatINR(bills.reduce((sum, bill) => sum + bill.totalPaise, 0))}</p>
          <p className="text-sm text-ink-500">{bills.map((bill) => bill.invoiceNumber).join(', ')}</p>
          {change > 0 && (
            <p className="mt-4 w-full rounded-xl bg-amber-50 px-4 py-3 text-lg font-semibold text-amber-800">Return change: {formatINR(change)}</p>
          )}
          <div className="mt-6 grid w-full gap-2">
            {bills.map((bill) => (
              <Button key={bill.id} variant="secondary" size="touch" onClick={() => print(bill)}>
                <Printer className="size-5" /> Print {bills.length > 1 ? bill.invoiceNumber : 'receipt'}
              </Button>
            ))}
            <Button size="touch" onClick={onFinished} autoFocus>New order</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open onClose={onFinished} title={`Take payment${bills.length > 1 ? ` · bill ${index + 1} of ${bills.length}` : ''}`} description={`Bill ${current.invoiceNumber}`}
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={() => print(current)}><Printer className="size-5" /> Print bill</Button>
          <Button variant="secondary" size="touch" onClick={onFinished}>Pay later</Button>
          <Button size="touch" disabled={!valid || remaining < 0 || cashProblem} loading={busy} onClick={() => void confirm()}>
            {remaining > 0 && valid ? `Record ${formatINR(entered)}` : 'Complete payment'}
          </Button>
        </>
      }
    >
      <div className="flex items-end justify-between rounded-xl bg-ink-900 px-5 py-4 text-white">
        <span className="text-sm text-slate-300">Amount due</span>
        <span className="text-3xl font-semibold tabular-nums">{formatINR(due)}</span>
      </div>

      <ul className="mt-4 space-y-4">
        {tenders.map((t, i) => (
          <li key={t.id} className="rounded-xl border border-line p-3">
            <div className="flex items-center gap-2">
              <div className="grid flex-1 grid-cols-4 gap-1.5" role="radiogroup" aria-label={`Payment method ${i + 1}`}>
                {METHODS.map((method) => (
                  <button
                    key={method.id} type="button" role="radio" aria-checked={t.method === method.id} onClick={() => update(t.id, { method: method.id, received: '' })}
                    className={cn('h-12 rounded-lg border text-sm font-semibold', t.method === method.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-ink-700 hover:bg-canvas')}
                  >
                    {method.label}
                  </button>
                ))}
              </div>
              {tenders.length > 1 && (
                <button type="button" aria-label={`Remove payment ${i + 1}`} onClick={() => setTenders(tenders.filter((other) => other.id !== t.id))} className="rounded-lg p-3 text-ink-500 hover:bg-red-50 hover:text-danger">
                  <Trash2 className="size-5" />
                </button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <TextField label="Amount" prefix="₹" inputMode="decimal" value={t.amount} onChange={(amount) => update(t.id, { amount })} />
              {t.method === 'CASH' ? (
                <TextField
                  label="Cash received" prefix="₹" inputMode="decimal" value={t.received} onChange={(received) => update(t.id, { received })} placeholder="Exact"
                  hint={inputToPaise(t.received) > amounts[i]! ? `Change ${formatINR(inputToPaise(t.received) - amounts[i]!)}` : undefined}
                  error={t.received.trim() !== '' && !(inputToPaise(t.received) >= amounts[i]!) ? 'Less than the amount' : undefined}
                />
              ) : (
                <TextField label="Reference (optional)" value={t.reference} onChange={(reference) => update(t.id, { reference })} placeholder={t.method === 'UPI' ? 'UPI transaction ID' : 'Last 4 digits or slip no.'} />
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={remaining <= 0} onClick={() => setTenders([...tenders, tender(remaining, 'UPI')])}>
          <Plus className="size-4" /> Add another payment
        </Button>
        <span className="ml-auto text-sm text-ink-500">Split equally:</span>
        {[2, 3, 4].map((parts) => (
          <Button key={parts} variant="secondary" onClick={() => setTenders(allocate(due, Array(parts).fill(1)).map((amount) => tender(amount)))} aria-label={`Split equally in ${parts}`}>
            {parts}
          </Button>
        ))}
      </div>
      {valid && remaining !== 0 && (
        <p role="status" className={cn('mt-3 text-sm font-medium', remaining < 0 ? 'text-danger' : 'text-amber-700')}>
          {remaining < 0 ? `${formatINR(-remaining)} more than is due.` : `${formatINR(remaining)} will still be due after this.`}
        </p>
      )}
    </Dialog>
  );
}

/** Split by item: decide how many of each line go on each bill. Every unit must land on one bill. */
export function SplitDialog({ lines, onSplit, onClose }: { lines: CartLine[]; onSplit: (parts: { orderItemId: string; quantity: number }[][]) => void; onClose: () => void }) {
  const [count, setCount] = useState(2);
  // quantities[lineId][billIndex]; everything starts on the first bill.
  const [quantities, setQuantities] = useState<Record<string, number[]>>(() => Object.fromEntries(lines.map((line) => [line.id, [line.quantity, 0, 0, 0]])));

  const move = (lineId: string, bill: number, delta: number) =>
    setQuantities((current) => {
      const row = [...current[lineId]!];
      // Units move between this bill and the first one, so the total for the line never changes.
      if (bill === 0 || row[bill]! + delta < 0 || row[0]! - delta < 0) return current;
      row[bill]! += delta;
      row[0]! -= delta;
      return { ...current, [lineId]: row };
    });

  function changeCount(next: number) {
    // Anything on a bill that is being removed goes back to the first bill.
    setQuantities((current) => Object.fromEntries(Object.entries(current).map(([id, row]) => {
      const kept = row.map((quantity, bill) => (bill < next ? quantity : 0));
      kept[0]! += row.slice(next).reduce((a, b) => a + b, 0);
      return [id, kept];
    })));
    setCount(next);
  }

  const parts = Array.from({ length: count }, (_, bill) => lines.flatMap((line) => (quantities[line.id]![bill]! > 0 ? [{ orderItemId: line.id, quantity: quantities[line.id]![bill]! }] : [])));
  const ready = parts.every((part) => part.length > 0);

  return (
    <Dialog
      open onClose={onClose} size="lg" title="Split bill by item" description="Each bill gets its own invoice number and is paid separately. To share one bill equally, use Split equally on the payment screen instead."
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onClose}>Cancel</Button>
          <Button size="touch" disabled={!ready} onClick={() => onSplit(parts)}>Create {count} bills</Button>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm font-medium text-ink-700">Number of bills</span>
        {[2, 3, 4].map((n) => (
          <button key={n} type="button" aria-pressed={count === n} onClick={() => changeCount(n)} className={cn('size-11 rounded-lg border text-sm font-semibold', count === n ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-ink-700')}>
            {n}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="py-2 pr-3 font-medium">Item</th>
              {Array.from({ length: count }, (_, bill) => <th key={bill} className="px-2 py-2 text-center font-medium">Bill {bill + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-line">
                <td className="py-2.5 pr-3">
                  <span className="font-medium text-ink-900">{line.name}</span>
                  <span className="block text-xs text-ink-500">{line.quantity} × {formatINR(line.unitPricePaise)}</span>
                </td>
                {Array.from({ length: count }, (_, bill) => (
                  <td key={bill} className="px-2 py-2.5">
                    {bill === 0 ? (
                      <p className="text-center text-base font-semibold tabular-nums text-ink-900">{quantities[line.id]![0]}</p>
                    ) : (
                      <div className="flex items-center justify-center gap-1.5">
                        <button type="button" aria-label={`Move one ${line.name} off bill ${bill + 1}`} onClick={() => move(line.id, bill, -1)} disabled={quantities[line.id]![bill] === 0} className="flex size-10 items-center justify-center rounded-lg border border-line disabled:opacity-30">
                          <Minus className="size-4" />
                        </button>
                        <span className="w-6 text-center text-base font-semibold tabular-nums">{quantities[line.id]![bill]}</span>
                        <button type="button" aria-label={`Move one ${line.name} to bill ${bill + 1}`} onClick={() => move(line.id, bill, 1)} disabled={quantities[line.id]![0] === 0} className="flex size-10 items-center justify-center rounded-lg border border-line disabled:opacity-30">
                          <Plus className="size-4" />
                        </button>
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!ready && <p className="mt-3 text-sm text-amber-700">Every bill needs at least one item.</p>}
    </Dialog>
  );
}
