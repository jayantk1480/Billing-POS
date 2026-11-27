'use client';

import { Button, Card, CardHeader, ErrorState, errorMessage, LoadingState, SelectField, Switch, TextField, toast, useApi, useFormState } from '@pos/ui';
import { type PrintLayoutsDto, updatePrintLayoutsSchema } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';

const COPIES = [1, 2, 3].map((count) => ({ value: String(count), label: count === 1 ? '1 copy' : `${count} copies` }));

function LayoutsForm({ layouts }: { layouts: PrintLayoutsDto }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useFormState({
    headerNote: layouts.receipt.headerNote ?? '',
    showCustomer: layouts.receipt.showCustomer,
    showHsn: layouts.receipt.showHsn,
    showTaxBreakup: layouts.receipt.showTaxBreakup,
    showAmountInWords: layouts.receipt.showAmountInWords,
    showUpiQr: layouts.receipt.showUpiQr,
    openDrawer: layouts.receipt.openDrawer,
    receiptCopies: String(layouts.receipt.copies),
    largeItems: layouts.kot.largeItems,
    showOrderedBy: layouts.kot.showOrderedBy,
    kotCopies: String(layouts.kot.copies),
  });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      receipt: {
        headerNote: values.headerNote.trim() || null, showCustomer: values.showCustomer, showHsn: values.showHsn, showTaxBreakup: values.showTaxBreakup,
        showAmountInWords: values.showAmountInWords, showUpiQr: values.showUpiQr, openDrawer: values.openDrawer, copies: Number(values.receiptCopies),
      },
      kot: { largeItems: values.largeItems, showOrderedBy: values.showOrderedBy, copies: Number(values.kotCopies) },
    };
    const saved = await form.submit(updatePrintLayoutsSchema, payload, async (data) => {
      queryClient.setQueryData(['print-layouts'], await api.printing.updateLayouts(data));
    });
    if (saved) toast.success('Print layouts saved');
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="grid gap-x-10 gap-y-8 p-5 lg:grid-cols-2">
        <section aria-label="Bills" className="space-y-5">
          <h3 className="text-sm font-semibold text-ink-900">Bills</h3>
          <TextField
            label="Line under the restaurant name" value={values.headerNote} onChange={(v) => set('headerNote', v)} error={errors['receipt.headerNote']} maxLength={80}
            placeholder="Pure veg · Since 1998" hint="Optional, for example a tagline or the branch name"
          />
          <Switch label="Show the customer" description="Name, phone and GSTIN, when the bill has a customer." checked={values.showCustomer} onChange={(v) => set('showCustomer', v)} />
          <Switch label="Show HSN codes" description="The HSN or SAC code beside each item." checked={values.showHsn} onChange={(v) => set('showHsn', v)} />
          <Switch label="Show the tax breakup" description="The taxable value and each tax, such as CGST and SGST, on its own line. Off: one line for GST." checked={values.showTaxBreakup} onChange={(v) => set('showTaxBreakup', v)} />
          <Switch label="Show the amount in words" checked={values.showAmountInWords} onChange={(v) => set('showAmountInWords', v)} />
          <Switch
            label="Print a UPI QR code on unpaid bills" checked={values.showUpiQr} onChange={(v) => set('showUpiQr', v)}
            description="For the amount still due. Needs a UPI ID under Billing & GST."
          />
          <Switch label="Open the cash drawer on cash bills" description="The drawer connected to the bill printer opens when a bill paid in cash is first printed, not for a duplicate." checked={values.openDrawer} onChange={(v) => set('openDrawer', v)} />
          <SelectField label="Copies of each bill" value={values.receiptCopies} onChange={(v) => set('receiptCopies', v)} error={errors['receipt.copies']} options={COPIES} />
        </section>
        <section aria-label="Kitchen tickets" className="space-y-5">
          <h3 className="text-sm font-semibold text-ink-900">Kitchen tickets</h3>
          <Switch label="Large item text" description="Items are printed in taller letters, easier to read from a distance." checked={values.largeItems} onChange={(v) => set('largeItems', v)} />
          <Switch label="Show who took the order" checked={values.showOrderedBy} onChange={(v) => set('showOrderedBy', v)} />
          <SelectField label="Copies of each ticket" value={values.kotCopies} onChange={(v) => set('kotCopies', v)} error={errors['kot.copies']} options={COPIES} />
        </section>
      </div>
      <div className="flex justify-end border-t border-line px-5 py-4">
        <Button type="submit" loading={form.submitting}>Save changes</Button>
      </div>
    </form>
  );
}

export function PrintLayoutsCard() {
  const api = useApi();
  const layouts = useQuery({ queryKey: ['print-layouts'], queryFn: api.printing.layouts });
  return (
    <Card>
      <CardHeader title="What is printed" description="What appears on bills and kitchen tickets sent to a thermal printer. The paper width comes from each printer." />
      {layouts.isPending ? (
        <LoadingState label="Loading print layouts" />
      ) : layouts.isError ? (
        <ErrorState message={errorMessage(layouts.error)} onRetry={() => void layouts.refetch()} />
      ) : (
        <LayoutsForm layouts={layouts.data} />
      )}
    </Card>
  );
}
