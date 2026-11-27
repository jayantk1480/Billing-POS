'use client';

import { formatINR } from '@pos/billing-core';
import { Button, cn, Dialog, inputToBps, inputToPaise, paiseToInput, TextAreaField, TextField, useApi } from '@pos/ui';
import { type CustomerLookupDto, type CustomerSuggestionDto, customerInputSchema, mobileSchema, type TableDto } from '@pos/validation';
import { useEffect, useState } from 'react';
import type { CartCustomer, CartDiscount, CartLine } from '@/lib/cart';

/** Percent or rupee discount with a reason. Used for a single line and for the whole bill. */
function DiscountFields({ value, onChange, base, error }: { value: Draft; onChange: (draft: Draft) => void; base: number; error?: string }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Discount type">
        {(['PERCENT', 'AMOUNT'] as const).map((type) => (
          <button
            key={type} type="button" role="radio" aria-checked={value.type === type} onClick={() => onChange({ ...value, type })}
            className={cn('h-12 rounded-xl border text-sm font-medium', value.type === type ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-700')}
          >
            {type === 'PERCENT' ? 'Percent %' : 'Amount ₹'}
          </button>
        ))}
      </div>
      <TextField
        label={value.type === 'PERCENT' ? 'Discount percent' : 'Discount amount'} inputMode="decimal" value={value.amount}
        onChange={(amount) => onChange({ ...value, amount })} prefix={value.type === 'AMOUNT' ? '₹' : undefined} suffix={value.type === 'PERCENT' ? '%' : undefined}
        hint={`On ${formatINR(base)}`} error={error} autoFocus
      />
      <TextField label="Reason" value={value.reason} onChange={(reason) => onChange({ ...value, reason })} placeholder="Regular guest, complaint, staff meal" />
    </div>
  );
}

interface Draft {
  type: 'PERCENT' | 'AMOUNT';
  amount: string;
  reason: string;
}

const toDraft = (discount: CartDiscount | null): Draft => ({
  type: discount?.type ?? 'PERCENT',
  amount: discount ? (discount.type === 'PERCENT' ? String(discount.value / 100) : paiseToInput(discount.value)) : '',
  reason: discount?.reason ?? '',
});

/** Returns null for an empty or invalid entry, which means "no discount". */
function fromDraft(draft: Draft): CartDiscount | null {
  const value = draft.type === 'PERCENT' ? inputToBps(draft.amount) : inputToPaise(draft.amount);
  if (!Number.isInteger(value) || value <= 0 || (draft.type === 'PERCENT' && value > 10_000)) return null;
  return { type: draft.type, value, reason: draft.reason.trim() };
}

export function DiscountDialog({ discount, base, onSave, onClose }: { discount: CartDiscount | null; base: number; onSave: (discount: CartDiscount | null) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(toDraft(discount));
  return (
    <Dialog
      open onClose={onClose} size="sm" title="Bill discount"
      footer={
        <>
          {discount && <Button variant="ghost" size="touch" onClick={() => { onSave(null); onClose(); }}>Remove</Button>}
          <Button variant="secondary" size="touch" onClick={onClose}>Cancel</Button>
          <Button size="touch" disabled={!fromDraft(draft)} onClick={() => { onSave(fromDraft(draft)); onClose(); }}>Apply</Button>
        </>
      }
    >
      <DiscountFields value={draft} onChange={setDraft} base={base} />
    </Dialog>
  );
}

/** Note and discount for one line of the order. */
export function LineDialog({ line, onSave, onRemove, onClose }: { line: CartLine; onSave: (patch: { notes: string; discount: CartDiscount | null }) => void; onRemove: () => void; onClose: () => void }) {
  const [notes, setNotes] = useState(line.notes);
  const [draft, setDraft] = useState(toDraft(line.discount));
  // Something typed that is not a usable discount is said so, not quietly dropped.
  const entered = draft.amount.trim() !== '';
  const discount = entered ? fromDraft(draft) : null;
  const problem = entered && !discount ? (draft.type === 'PERCENT' ? 'Enter a percentage up to 100' : 'Enter an amount above zero') : undefined;
  return (
    <Dialog
      open onClose={onClose} size="sm" title={line.name} description={[line.variantName, ...line.modifierNames].filter(Boolean).join(' · ') || undefined}
      footer={
        <>
          <Button variant="danger" size="touch" onClick={() => { onRemove(); onClose(); }}>Remove item</Button>
          <Button variant="secondary" size="touch" onClick={onClose}>Cancel</Button>
          <Button size="touch" disabled={Boolean(problem)} onClick={() => { onSave({ notes: notes.trim(), discount }); onClose(); }}>Save</Button>
        </>
      }
    >
      <div className="space-y-5">
        <TextAreaField label="Note for the kitchen" value={notes} onChange={setNotes} rows={2} maxLength={200} placeholder="Less spicy, no onion" />
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink-900">Discount on this item</legend>
          <DiscountFields value={draft} onChange={setDraft} base={line.quantity * line.unitPricePaise} error={problem} />
        </fieldset>
      </div>
    </Dialog>
  );
}

export function CustomerDialog({ customer, onSave, onClose }: { customer: CartCustomer | null; onSave: (customer: CartCustomer | null) => void; onClose: () => void }) {
  const api = useApi();
  const [draft, setDraft] = useState<CartCustomer>(customer ?? { name: '', phone: '', address: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [found, setFound] = useState<CustomerLookupDto['customer']>(null);
  const [suggestions, setSuggestions] = useState<CustomerSuggestionDto[]>([]);
  // Typing in a field takes its error away, so the hint under it can be read again.
  const set = (key: keyof CartCustomer) => (value: string) => {
    setDraft({ ...draft, [key]: value });
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  // The mobile number is the customer. While it is being typed, customers whose number begins that way are offered;
  // picking one fills the form in. Once a whole number is in, the customer on record fills in the fields still empty.
  const digits = draft.phone.replace(/\D/g, '');
  const mobile = mobileSchema.safeParse(draft.phone);
  const number = mobile.success ? mobile.data : null;
  // A number that is long enough but wrong is said so as it is typed, not only on Save.
  const liveError = digits.length >= 10 && !number ? 'Enter a 10-digit mobile number' : undefined;
  useEffect(() => {
    if (number || digits.length < 3) {
      setSuggestions([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.customers.suggest(draft.phone).then((result) => current && setSuggestions(result)).catch(() => current && setSuggestions([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, draft.phone, digits.length, number]);
  useEffect(() => {
    if (!number) {
      setFound(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.customers.lookup(number).then((result) => {
        if (!current) return;
        setFound(result.customer);
        const known = result.customer;
        if (known) setDraft((d) => ({ ...d, name: d.name || (known.name ?? ''), address: d.address || (known.address ?? '') }));
      }).catch(() => current && setFound(null));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, number]);

  function pick(suggestion: CustomerSuggestionDto) {
    setDraft({ phone: suggestion.phone, name: suggestion.name ?? '', address: suggestion.address ?? '' });
    setSuggestions([]);
    setErrors({});
  }

  function save() {
    const parsed = customerInputSchema.safeParse(draft);
    if (!parsed.success) return setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message])));
    onSave({ ...draft, phone: parsed.data.phone, name: draft.name.trim() });
    onClose();
  }

  const orders = (count: number) => `${count} ${count === 1 ? 'order' : 'orders'}`;
  return (
    <Dialog
      open onClose={onClose} size="sm" title="Customer" description="Identified by the mobile number. The name is printed on the bill."
      footer={
        <>
          {customer && <Button variant="ghost" size="touch" onClick={() => { onSave(null); onClose(); }}>Remove</Button>}
          <Button variant="secondary" size="touch" onClick={onClose}>Cancel</Button>
          <Button size="touch" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField
          label="Mobile number" type="tel" inputMode="tel" value={draft.phone} onChange={set('phone')} error={errors.phone ?? liveError} autoFocus maxLength={20}
          hint={found ? `On record${found.name ? ` as ${found.name}` : ''}${found.orderCount > 0 ? ` · ${orders(found.orderCount)} before` : ''}` : 'One number is one customer; their details come back next time.'}
        />
        {suggestions.length > 0 && (
          <ul aria-label="Customers on record" className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id}>
                <button type="button" onClick={() => pick(suggestion)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-canvas">
                  <span className="truncate"><span className="font-medium tabular-nums text-ink-900">{suggestion.phone}</span>{suggestion.name && <span className="text-ink-700"> · {suggestion.name}</span>}</span>
                  <span className="shrink-0 text-xs text-ink-500">{orders(suggestion.orderCount)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <TextField label="Name" value={draft.name} onChange={set('name')} error={errors.name} />
        <TextAreaField label="Address" value={draft.address} onChange={set('address')} error={errors.address} rows={2} hint="Used as the delivery address for delivery orders" />
      </div>
    </Dialog>
  );
}

const TABLE_STYLE: Record<TableDto['status'], string> = {
  FREE: 'border-green-600/40 bg-green-50 text-green-800',
  OCCUPIED: 'border-amber-500/50 bg-amber-50 text-amber-800',
  BILL_PRINTED: 'border-blue-500/50 bg-blue-50 text-blue-800',
  BLOCKED: 'border-line bg-canvas text-ink-500',
};
const TABLE_LABEL: Record<TableDto['status'], string> = { FREE: 'Free', OCCUPIED: 'Occupied', BILL_PRINTED: 'Bill printed', BLOCKED: 'Blocked' };

/**
 * The floor as it is laid out in the back office. A free table starts a new order there;
 * an occupied one opens its running order.
 */
export function TableDialog({ tables, currentId, onPick, onClose }: { tables: TableDto[]; currentId: string | null; onPick: (table: TableDto) => void; onClose: () => void }) {
  const areas = [...new Map(tables.map((table) => [table.areaId, table.areaName])).entries()];
  const [areaId, setAreaId] = useState(tables.find((table) => table.id === currentId)?.areaId ?? areas[0]?.[0] ?? '');
  const shown = tables.filter((table) => table.areaId === areaId);
  // The plan is as big as its furthest table, and scrolls if that is larger than the dialog.
  const planWidth = Math.max(...shown.map((table) => table.posX + table.width), 0) + 24;
  const planHeight = Math.max(...shown.map((table) => table.posY + table.height), 0) + 24;
  const inNameOrder = [...shown].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const caption = (table: TableDto) => (
    <>
      <span className="text-base font-semibold">{table.name}</span>
      <span className="text-[11px]">
        {table.orderTotalPaise !== null ? formatINR(table.orderTotalPaise) : table.status === 'BLOCKED' ? 'Blocked' : `${table.seats} seats`}
      </span>
      {table.status === 'BILL_PRINTED' && <span className="text-[10px] font-medium">Bill printed</span>}
    </>
  );

  return (
    <Dialog open onClose={onClose} size="lg" title="Choose a table" description="Green is free. Tap an occupied table to open its order.">
      {tables.length === 0 ? (
        <p className="text-sm text-ink-500">No tables are set up yet. Add them under Floor in the back office.</p>
      ) : (
        <>
          <div className="mb-3 flex gap-2 overflow-x-auto" role="tablist" aria-label="Areas">
            {areas.map(([id, name]) => (
              <button
                key={id} type="button" role="tab" aria-selected={id === areaId} onClick={() => setAreaId(id)}
                className={cn('h-11 shrink-0 rounded-full border px-4 text-sm font-medium', id === areaId ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-700')}
              >
                {name}
              </button>
            ))}
          </div>
          {/* A phone is too narrow for the floor plan, so there the tables are a grid of large buttons in name order. */}
          <ul className="grid grid-cols-3 gap-2 sm:hidden" aria-label="Tables">
            {inNameOrder.map((table) => (
              <li key={table.id}>
                <button
                  type="button" disabled={table.status === 'BLOCKED'} onClick={() => { onPick(table); onClose(); }}
                  aria-label={`Table ${table.name}, ${TABLE_LABEL[table.status]}`}
                  className={cn('flex h-20 w-full flex-col items-center justify-center rounded-xl border-2 text-center leading-tight', TABLE_STYLE[table.status], currentId === table.id && 'ring-2 ring-brand-600 ring-offset-2')}
                >
                  {caption(table)}
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-auto rounded-xl border border-line bg-canvas sm:block" style={{ maxHeight: '60dvh' }}>
            <div className="relative" style={{ width: planWidth, height: planHeight, minWidth: '100%' }}>
              {shown.map((table) => (
                <button
                  key={table.id} type="button" disabled={table.status === 'BLOCKED'} onClick={() => { onPick(table); onClose(); }}
                  aria-label={`Table ${table.name}, ${TABLE_LABEL[table.status]}`}
                  className={cn(
                    'absolute flex flex-col items-center justify-center border-2 text-center leading-tight',
                    table.shape === 'ROUND' ? 'rounded-full' : 'rounded-xl', TABLE_STYLE[table.status], currentId === table.id && 'ring-2 ring-brand-600 ring-offset-2',
                  )}
                  style={{ left: table.posX, top: table.posY, width: table.width, height: table.height }}
                >
                  {caption(table)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
