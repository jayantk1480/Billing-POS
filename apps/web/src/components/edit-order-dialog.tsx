'use client';

import { formatINR } from '@pos/billing-core';
import {
  Button, cn, ConfirmDialog, Dialog, discountFromOrder, discountInput, ErrorState, errorMessage, type LineChoice, lineFromProduct, lineInputs, linesBill, linesFromOrder,
  LoadingState, type OrderLine, sameChoice, TextField, toast, useApi,
} from '@pos/ui';
import type { OrderDto, PaymentMethod, PosBootstrap, ProductDto } from '@pos/validation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Minus, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';

const METHODS: { id: PaymentMethod; label: string }[] = [{ id: 'CASH', label: 'Cash' }, { id: 'UPI', label: 'UPI' }, { id: 'CARD', label: 'Card' }, { id: 'OTHER', label: 'Other' }];
const describe = (line: Pick<OrderLine, 'variantName' | 'modifierNames'>) => [line.variantName, ...line.modifierNames].filter(Boolean).join(' · ');

/** Variant and add-ons for an item that has them, shown in place under the search box. */
function OptionsPicker({ product, boot, onAdd, onCancel }: { product: ProductDto; boot: PosBootstrap; onAdd: (line: LineChoice) => void; onCancel: () => void }) {
  const groups = boot.modifierGroups.filter((group) => product.modifierGroupIds.includes(group.id));
  const [variantId, setVariantId] = useState<string | null>(product.variants.find((v) => v.isAvailable)?.id ?? null);
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (groupId: string, modifierId: string) => {
    const group = groups.find((g) => g.id === groupId)!;
    const inGroup = chosen.filter((id) => group.modifiers.some((m) => m.id === id));
    if (chosen.includes(modifierId)) return setChosen(chosen.filter((id) => id !== modifierId));
    // In a choose-one group a new pick replaces the old one; otherwise stop at the maximum.
    if (group.maxSelect === 1) return setChosen([...chosen.filter((id) => !inGroup.includes(id)), modifierId]);
    if (inGroup.length < group.maxSelect) setChosen([...chosen, modifierId]);
  };
  const unmet = groups.find((group) => chosen.filter((id) => group.modifiers.some((m) => m.id === id)).length < group.minSelect);
  const line = lineFromProduct(product, boot, variantId, chosen);
  const ready = (product.variants.length === 0 || variantId) && !unmet;
  const option = (active: boolean) => cn('flex h-10 items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm disabled:opacity-40', active ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-line bg-surface hover:border-ink-300');

  return (
    <div className="space-y-3 rounded-xl border border-line bg-canvas p-3" role="group" aria-label={`Options for ${product.name}`}>
      <p className="text-sm font-semibold text-ink-900">{product.name}</p>
      {product.variants.length > 0 && (
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Variant">
          {product.variants.map((variant) => (
            <button key={variant.id} type="button" role="radio" aria-checked={variantId === variant.id} disabled={!variant.isAvailable} onClick={() => setVariantId(variant.id)} className={option(variantId === variant.id)}>
              <span className="font-medium text-ink-900">{variant.name}</span><span className="tabular-nums text-ink-700">{formatINR(variant.pricePaise)}</span>
            </button>
          ))}
        </div>
      )}
      {groups.map((group) => (
        <fieldset key={group.id}>
          <legend className="text-xs font-medium text-ink-500">
            {group.name} · {group.minSelect > 0 ? `choose ${group.minSelect === group.maxSelect ? group.minSelect : `${group.minSelect} to ${group.maxSelect}`}` : `optional, up to ${group.maxSelect}`}
          </legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {group.modifiers.map((modifier) => (
              <button key={modifier.id} type="button" role="checkbox" aria-checked={chosen.includes(modifier.id)} disabled={!modifier.isAvailable} onClick={() => toggle(group.id, modifier.id)} className={option(chosen.includes(modifier.id))}>
                <span className="font-medium text-ink-900">{modifier.name}</span><span className="tabular-nums text-ink-500">{modifier.pricePaise ? `+ ${formatINR(modifier.pricePaise)}` : ''}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={!ready} onClick={() => onAdd(line)}>Add {formatINR(line.unitPricePaise)}</Button>
      </div>
    </div>
  );
}

function Editor({ order, boot, onDone, onClose, onSendToPos }: { order: OrderDto; boot: PosBootstrap; onDone: () => void; onClose: () => void; onSendToPos: () => void }) {
  const api = useApi();
  const billed = order.status === 'BILLED' || order.status === 'SETTLED';
  const billNumbers = order.invoices.filter((invoice) => invoice.status !== 'CANCELLED').map((invoice) => invoice.invoiceNumber);
  const paidBefore = order.invoices.reduce((sum, invoice) => sum + (invoice.status === 'CANCELLED' ? 0 : invoice.paidPaise - invoice.refundedPaise), 0);

  const [lines, setLines] = useState<OrderLine[]>(() => linesFromOrder(order));
  const [discount] = useState(() => discountFromOrder(order));
  const [search, setSearch] = useState('');
  const [choosing, setChoosing] = useState<ProductDto | null>(null);
  const [reason, setReason] = useState('');
  // What happens to the money. A bill paid in full by one method stays paid by it, for the new total. A bill that was
  // part paid, or paid by several methods, keeps its payments exactly as they are unless something else is picked.
  const paidInFullByOne = paidBefore > 0 && paidBefore >= order.totals.totalPaise && order.paymentMethods.length === 1;
  const startsWith: PaymentMethod | 'KEEP' | null = paidBefore === 0 ? null : paidInFullByOne ? order.paymentMethods[0]! : 'KEEP';
  const [paidBy, setPaidBy] = useState<PaymentMethod | 'KEEP' | null>(startsWith);
  const [reference, setReference] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const paidWith = order.paymentMethods.map((method) => METHODS.find((entry) => entry.id === method)!.label).join(' + ');

  const bill = linesBill(lines, discount, boot);
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const term = search.trim().toLowerCase();
  const matches = term
    ? boot.products.filter((product) => product.isAvailable && (product.name.toLowerCase().includes(term) || product.shortCode?.toLowerCase().startsWith(term))).slice(0, 6)
    : [];
  const changed = JSON.stringify(lineInputs(lines)) !== JSON.stringify(lineInputs(linesFromOrder(order))) || (billed && paidBy !== startsWith);
  // Keeping the payments only works while they do not come to more than the new total.
  const keepsTooMuch = billed && paidBy === 'KEEP' && paidBefore > bill.totalPaise;
  // Taking away something the kitchen was sent has to be explained, as it is on the billing screen.
  const reducesSent = !billed && order.items.some((item) => item.kotQuantity > (lines.find((line) => line.id === item.id)?.quantity ?? 0));
  const needsReason = billed || reducesSent;

  const setQuantity = (id: string, quantity: number) =>
    setLines((current) => (quantity <= 0 ? current.filter((line) => line.id !== id) : current.map((line) => (line.id === id ? { ...line, quantity: Math.min(quantity, 999) } : line))));
  const add = (choice: LineChoice) => {
    setLines((current) => {
      const match = current.find((line) => sameChoice(line, choice) && !line.notes && !line.discount);
      return match
        ? current.map((line) => (line === match ? { ...line, quantity: line.quantity + 1 } : line))
        : [...current, { ...choice, id: crypto.randomUUID(), quantity: 1, kotQuantity: 0, notes: '', discount: null }];
    });
    setSearch('');
    setChoosing(null);
  };
  const pick = (product: ProductDto) => (product.variants.length > 0 || product.modifierGroupIds.length > 0 ? setChoosing(product) : add(lineFromProduct(product, boot, null, [])));

  const save = useMutation({
    mutationFn: () =>
      billed
        ? api.orders.amend(order.id, {
            items: lineInputs(lines), discount: discountInput(discount), reason: reason.trim(),
            payment: paidBy === 'KEEP' ? 'KEEP' : paidBy ? { method: paidBy, reference: paidBy === 'CASH' ? null : reference.trim() || null } : null,
          })
        : api.orders.save(order.id, {
            type: order.type, tableId: order.tableId, guests: order.guests, notes: order.notes, deliveryAddress: order.deliveryAddress,
            customer: order.customer?.phone ? { phone: order.customer.phone, name: order.customer.name, address: order.customer.address } : null,
            items: lineInputs(lines), discount: discountInput(discount), version: order.version, kotCancelReason: reason.trim() || null,
          }),
    onSuccess: (saved) => {
      toast.success(billed
        ? `Order ${saved.displayNumber} changed. Bill ${saved.invoices.at(-1)?.invoiceNumber} is now ${formatINR(saved.totals.totalPaise)}.`
        : `Order ${saved.displayNumber} changed. It is now ${formatINR(saved.totals.totalPaise)}.`);
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const choice = (active: boolean) => cn('min-h-10 rounded-lg border px-2 py-1.5 text-sm font-semibold', active ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-ink-700 hover:bg-canvas');
  const row = (label: string, value: string, strong = false) => (
    <div className={cn('flex justify-between', strong && 'border-t border-line pt-2 text-base font-semibold text-ink-900')}><dt className={strong ? undefined : 'text-ink-500'}>{label}</dt><dd className="tabular-nums">{value}</dd></div>
  );

  return (
    <Dialog
      open onClose={() => (changed && !save.isPending ? setConfirmClose(true) : onClose())} size="lg" title={`Change order ${order.displayNumber}`}
      description={billed
        ? 'Change the items here. The bill is issued again under the same number and date, with the new total.'
        : 'Change the items here. The order stays open on the billing screen, where it is billed as usual.'}
      footer={
        <>
          {billed && <Button variant="ghost" className="mr-auto" onClick={onSendToPos} disabled={save.isPending}>Change on the billing screen instead</Button>}
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={lines.length === 0 || !changed || keepsTooMuch || (needsReason && !reason.trim())}>Save changes</Button>
        </>
      }
    >
      <div className="space-y-5 text-sm">
        {billed && (
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2.5 text-amber-800">
            Saving replaces bill {billNumbers.join(', ')}{paidBefore > 0 && ` and the ${formatINR(paidBefore)} recorded against it`}. This cannot be undone.
            {order.invoices.some((invoice) => invoice.refundedPaise > 0) && ' Refunds made on the old bill are removed with it.'}
            {billNumbers.length > 1 && ' The order was split into several bills; it comes back as one, under the first number, and because it is then rounded once its total can differ by a rupee.'}
          </p>
        )}

        {lines.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-ink-500">An order needs at least one item. To remove the order altogether, delete it instead.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Order items">
            {lines.map((line) => (
              <li key={line.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink-900">{line.name}</span>
                  <span className="block text-xs text-ink-500">{[describe(line), formatINR(line.unitPricePaise) + ' each'].filter(Boolean).join(' · ')}</span>
                  {line.notes && <span className="block text-xs italic text-amber-700">{line.notes}</span>}
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" aria-label={line.quantity === 1 ? `Remove ${line.name}` : `One less ${line.name}`} onClick={() => setQuantity(line.id, line.quantity - 1)} className="flex size-9 items-center justify-center rounded-lg border border-line text-ink-700 hover:bg-canvas">
                    {line.quantity === 1 ? <Trash2 className="size-4 text-danger" /> : <Minus className="size-4" />}
                  </button>
                  <span className="w-8 text-center text-base font-semibold tabular-nums" aria-label={`Quantity of ${line.name}`}>{line.quantity}</span>
                  <button type="button" aria-label={`One more ${line.name}`} onClick={() => setQuantity(line.id, line.quantity + 1)} className="flex size-9 items-center justify-center rounded-lg border border-line text-ink-700 hover:bg-canvas">
                    <Plus className="size-4" />
                  </button>
                </span>
                <span className="w-24 text-right font-medium tabular-nums text-ink-900">{formatINR(bill.lines.find((entry) => entry.id === line.id)?.grossPaise ?? 0)}</span>
              </li>
            ))}
          </ul>
        )}

        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input
              type="search" value={search} onChange={(event) => { setSearch(event.target.value); setChoosing(null); }} aria-label="Add an item"
              placeholder="Add an item: type its name or short code" className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm placeholder:text-ink-500"
            />
          </div>
          {term && !choosing && (
            matches.length === 0 ? <p className="mt-2 text-ink-500">Nothing on the menu matches &ldquo;{search.trim()}&rdquo;.</p> : (
              <ul className="mt-2 divide-y divide-line rounded-xl border border-line" aria-label="Matching items">
                {matches.map((product) => (
                  <li key={product.id}>
                    <button type="button" onClick={() => pick(product)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-canvas">
                      <span className="font-medium text-ink-900">{product.name}{product.shortCode && <span className="ml-2 font-mono text-xs font-normal text-ink-500">{product.shortCode}</span>}</span>
                      <span className="tabular-nums text-ink-700">{formatINR(product.basePricePaise)}{product.variants.length > 0 && ' +'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
          {choosing && <div className="mt-2"><OptionsPicker key={choosing.id} product={choosing} boot={boot} onAdd={add} onCancel={() => setChoosing(null)} /></div>}
        </div>

        <dl className="ml-auto max-w-xs space-y-1" aria-label="New totals">
          {row(`Subtotal (${units} ${units === 1 ? 'item' : 'items'})`, formatINR(bill.grossPaise))}
          {bill.discountPaise > 0 && row('Discount', `− ${formatINR(bill.discountPaise)}`)}
          {bill.serviceChargePaise > 0 && row('Service charge', formatINR(bill.serviceChargePaise))}
          {bill.taxPaise > 0 && row(bill.taxAddedPaise === 0 ? 'GST (included)' : 'GST', formatINR(bill.taxPaise))}
          {bill.roundOffPaise !== 0 && row('Round off', formatINR(bill.roundOffPaise))}
          {row('New total', formatINR(bill.totalPaise), true)}
          {bill.totalPaise !== order.totals.totalPaise && <div className="text-ink-500">{row('Was', formatINR(order.totals.totalPaise))}</div>}
        </dl>

        {billed && (
          <div>
            <p className="mb-1.5 font-medium text-ink-700">
              The new total is {formatINR(bill.totalPaise)}.{' '}
              {paidBefore > 0 ? `${formatINR(paidBefore)} was received against the old bill${paidWith ? `, by ${paidWith}` : ''}.` : 'Nothing has been received against the old bill.'}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="How the new total is paid">
              {paidBefore > 0 && (
                <button type="button" role="radio" aria-checked={paidBy === 'KEEP'} onClick={() => setPaidBy('KEEP')} className={cn(choice(paidBy === 'KEEP'), 'col-span-full')}>
                  Keep the payments as recorded
                </button>
              )}
              {METHODS.map((method) => (
                <button key={method.id} type="button" role="radio" aria-checked={paidBy === method.id} onClick={() => setPaidBy(method.id)} className={choice(paidBy === method.id)}>
                  Paid by {method.label}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={paidBy === null} onClick={() => setPaidBy(null)} className={cn(choice(paidBy === null), 'col-span-full')}>
                Not paid yet
              </button>
            </div>
            <p role={keepsTooMuch ? 'alert' : undefined} className={cn('mt-1.5 text-xs', keepsTooMuch ? 'font-medium text-danger' : 'text-ink-500')}>
              {paidBy === 'KEEP'
                ? keepsTooMuch
                  ? `${formatINR(paidBefore)} was received, which is more than the new total. Pick how the new total was paid instead.`
                  : paidBefore < bill.totalPaise
                    ? `The payments stay as they are and ${formatINR(bill.totalPaise - paidBefore)} is left due. Take it under Running orders on the billing screen.`
                    : 'The payments stay exactly as they are.'
                : paidBy
                  ? `The whole ${formatINR(bill.totalPaise)} is recorded as paid by ${METHODS.find((entry) => entry.id === paidBy)!.label}, dated as the original payment.${order.paymentMethods.length > 1 || (paidBefore > 0 && !paidInFullByOne) ? ' This replaces the payments recorded so far.' : ''}`
                  : paidBefore > 0
                    ? `The ${formatINR(paidBefore)} recorded as received is removed and the bill is left unpaid.`
                    : 'The bill is left unpaid. Take the payment under Running orders on the billing screen.'}
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {billed && paidBy && paidBy !== 'KEEP' && paidBy !== 'CASH' && <TextField label="Payment reference (optional)" value={reference} onChange={setReference} placeholder={paidBy === 'UPI' ? 'UPI transaction ID' : 'Last 4 digits or slip no.'} />}
          {needsReason && (
            <TextField
              label="Reason" value={reason} onChange={setReason} placeholder="Required, and kept in the audit log"
              hint={reducesSent ? 'Needed because items already sent to the kitchen are being reduced. The kitchen gets a cancellation ticket.' : undefined}
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmClose} onClose={() => setConfirmClose(false)} onConfirm={onClose} danger
        title="Discard your changes?" confirmLabel="Discard changes" message="The changes you made to this order have not been saved."
      />
    </Dialog>
  );
}

/**
 * Changes the items of any order from the back office. An open order is simply saved. A billed order
 * has its bill issued again under the same number, which needs the right to erase bills.
 */
export function EditOrderDialog({ orderId, onDone, onClose, onSendToPos }: { orderId: string; onDone: () => void; onClose: () => void; onSendToPos: () => void }) {
  const api = useApi();
  // Always the latest: the totals shown must match what the server will work from.
  const order = useQuery({ queryKey: ['order', orderId, 'edit'], queryFn: () => api.orders.get(orderId), gcTime: 0 });
  const boot = useQuery({ queryKey: ['pos-bootstrap'], queryFn: api.pos.bootstrap });
  if (order.data && boot.data) return <Editor order={order.data} boot={boot.data} onDone={onDone} onClose={onClose} onSendToPos={onSendToPos} />;
  const failed = order.error ?? boot.error;
  return (
    <Dialog open onClose={onClose} size="lg" title="Change order">
      {failed ? <ErrorState message={errorMessage(failed)} onRetry={() => { void order.refetch(); void boot.refetch(); }} /> : <LoadingState />}
    </Dialog>
  );
}
