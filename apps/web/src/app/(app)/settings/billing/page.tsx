'use client';

import { Button, Card, CardHeader, ErrorState, errorMessage, LoadingState, PageHeader, SelectField, Switch, TextAreaField, TextField, toast, useApi, useFormState } from '@pos/ui';
import { type SettingsDto, type TaxGroupDto, updateSettingsSchema } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { bpsToInput, inputToBps } from '@/lib/format';

const minutesToTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const timeToMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours! * 60 + minutes! : Number.NaN;
};

/** Only the KOT button makes kitchen tickets; Bill & pay never does. This chooses whether KOT also prints them. */
const KOT_PRINTING_HINT: Record<string, string> = {
  ON_KOT: 'The KOT button sends new items to the kitchen and prints the ticket.',
  OFF: 'The KOT button sends new items to the kitchen display without printing.',
};

function BillingForm({ settings, taxGroups }: { settings: SettingsDto; taxGroups: TaxGroupDto[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useFormState({
    gstRegistration: settings.gstRegistration as string,
    pricesIncludeTax: settings.pricesIncludeTax,
    defaultTaxGroupId: settings.defaultTaxGroupId ?? '',
    roundOffMode: settings.roundOffMode as string,
    serviceChargeEnabled: settings.serviceChargeEnabled,
    serviceCharge: bpsToInput(settings.serviceChargeBps),
    discountCap: bpsToInput(settings.discountCapBps),
    dayCutoff: minutesToTime(settings.dayCutoffMinutes),
    orderNumberReset: settings.orderNumberReset as string,
    orderRenumberMode: settings.orderRenumberMode as string,
    kotPrinting: settings.autoPrintKot ? 'ON_KOT' : 'OFF',
    billPrinting: settings.autoPrintReceipt ? 'AUTO' : 'MANUAL',
    registerRequired: settings.registerRequired,
    invoiceFooter: settings.invoiceFooter ?? '',
    upiVpa: settings.upiVpa ?? '',
  });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      gstRegistration: values.gstRegistration,
      pricesIncludeTax: values.pricesIncludeTax,
      defaultTaxGroupId: values.defaultTaxGroupId || null,
      roundOffMode: values.roundOffMode,
      serviceChargeEnabled: values.serviceChargeEnabled,
      serviceChargeBps: values.serviceChargeEnabled ? inputToBps(values.serviceCharge) : 0,
      discountCapBps: inputToBps(values.discountCap),
      dayCutoffMinutes: timeToMinutes(values.dayCutoff),
      orderNumberReset: values.orderNumberReset,
      orderRenumberMode: values.orderRenumberMode,
      autoPrintKot: values.kotPrinting === 'ON_KOT',
      autoPrintReceipt: values.billPrinting === 'AUTO',
      registerRequired: values.registerRequired,
      invoiceFooter: values.invoiceFooter,
      upiVpa: values.upiVpa,
    };
    const saved = await form.submit(updateSettingsSchema, payload, async (data) => {
      queryClient.setQueryData(['settings'], await api.settings.update(data));
    });
    if (saved) toast.success('Billing settings saved');
  }

  const registered = values.gstRegistration === 'REGULAR';

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <Card>
        <CardHeader title="GST" description="How tax is charged and shown on bills." />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <SelectField
            label="GST registration" value={values.gstRegistration} onChange={(v) => set('gstRegistration', v)} error={errors.gstRegistration}
            options={[
              { value: 'REGULAR', label: 'Regular: charge GST, issue tax invoices' },
              { value: 'COMPOSITION', label: 'Composition scheme: no GST on bills' },
              { value: 'UNREGISTERED', label: 'Not registered: no GST on bills' },
            ]}
            hint={registered ? 'Bills are tax invoices with CGST and SGST shown' : 'Bills are issued as a "Bill of Supply" with no tax lines'}
          />
          <SelectField
            label="Default tax group" value={values.defaultTaxGroupId} onChange={(v) => set('defaultTaxGroupId', v)} error={errors.defaultTaxGroupId}
            placeholder="None" disabled={!registered} hint="Used by products that do not choose their own"
            options={taxGroups.filter((t) => t.isActive || t.id === values.defaultTaxGroupId).map((t) => ({ value: t.id, label: t.name }))}
          />
          <div className="sm:col-span-2">
            <Switch
              label="Menu prices include tax" checked={values.pricesIncludeTax} onChange={(v) => set('pricesIncludeTax', v)} disabled={!registered}
              description="On: a ₹105 item is ₹100 plus ₹5 GST. Off: GST is added on top of the menu price. Products can override this."
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Bill totals" />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <SelectField
            label="Round off" value={values.roundOffMode} onChange={(v) => set('roundOffMode', v)}
            options={[{ value: 'NEAREST_RUPEE', label: 'Round the bill total to the nearest rupee' }, { value: 'NONE', label: 'Do not round' }]}
          />
          <TextField
            label="Discount limit for cashiers" suffix="%" inputMode="decimal" value={values.discountCap} onChange={(v) => set('discountCap', v)}
            error={errors.discountCapBps} hint="Larger discounts need a manager's approval"
          />
          <div className="sm:col-span-2">
            <Switch
              label="Service charge" checked={values.serviceChargeEnabled} onChange={(v) => set('serviceChargeEnabled', v)}
              description="Shown on the bill as optional. Guests may ask for it to be removed."
            />
          </div>
          {values.serviceChargeEnabled && (
            <TextField label="Service charge rate" suffix="%" inputMode="decimal" value={values.serviceCharge} onChange={(v) => set('serviceCharge', v)} error={errors.serviceChargeBps} />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Order numbers and business day" />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <SelectField
            label="Order numbers restart" value={values.orderNumberReset} onChange={(v) => set('orderNumberReset', v)}
            options={[{ value: 'DAILY', label: 'Every day' }, { value: 'FINANCIAL_YEAR', label: 'Every financial year (1 April)' }, { value: 'NEVER', label: 'Never' }]}
          />
          <SelectField
            label="When an unbilled order is deleted" value={values.orderRenumberMode} onChange={(v) => set('orderRenumberMode', v)}
            hint="Order numbers always follow this. Bill numbers follow it too when a billed order is deleted, which only the owner can do."
            options={[
              { value: 'AUTO', label: 'Renumber later orders to close the gap' },
              { value: 'MANUAL', label: 'Leave the gap until I reset the numbers' },
              { value: 'OFF', label: 'Always leave the gap' },
            ]}
          />
          <TextField
            label="Business day starts at" type="time" value={values.dayCutoff} onChange={(v) => set('dayCutoff', v)} error={errors.dayCutoffMinutes}
            hint="Sales before this time count towards the previous day. Use 00:00 unless you stay open past midnight."
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Printing and payments" />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <SelectField
            label="Print kitchen tickets (KOT)" value={values.kotPrinting} onChange={(v) => set('kotPrinting', v)}
            hint={KOT_PRINTING_HINT[values.kotPrinting]}
            options={[
              { value: 'ON_KOT', label: 'When KOT is pressed' },
              { value: 'OFF', label: "Don't print (kitchen display only)" },
            ]}
          />
          <SelectField
            label="Print the bill" value={values.billPrinting} onChange={(v) => set('billPrinting', v)}
            hint={values.billPrinting === 'AUTO' ? 'Prints by itself as soon as the bill is paid in full.' : 'Prints only when Print is pressed on the bill.'}
            options={[
              { value: 'AUTO', label: 'Automatically when paid in full' },
              { value: 'MANUAL', label: 'Only when Print is pressed' },
            ]}
          />
          <div className="sm:col-span-2">
            <Switch
              label="Cash can only be taken with the cash register open" checked={values.registerRequired} onChange={(v) => set('registerRequired', v)}
              description="On: a cashier must open their cash register before taking a cash payment, so all cash is counted when it is closed."
            />
          </div>
          <TextField label="UPI ID for payment QR" value={values.upiVpa} onChange={(v) => set('upiVpa', v)} error={errors.upiVpa} placeholder="restaurant@bank" hint="Leave empty to hide the QR code" />
          <TextAreaField label="Bill footer" value={values.invoiceFooter} onChange={(v) => set('invoiceFooter', v)} error={errors.invoiceFooter} rows={2} maxLength={300} />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={form.submitting}>Save changes</Button>
      </div>
    </form>
  );
}

export default function BillingSettingsPage() {
  const api = useApi();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const taxGroups = useQuery({ queryKey: ['tax-groups'], queryFn: api.taxGroups.list });
  return (
    <>
      <PageHeader title="Billing & GST" description="Rules applied to every bill. Changes affect new bills only." />
      {settings.isPending || taxGroups.isPending ? (
        <Card><LoadingState /></Card>
      ) : settings.isError || taxGroups.isError ? (
        <Card><ErrorState message={errorMessage(settings.error ?? taxGroups.error)} onRetry={() => { void settings.refetch(); void taxGroups.refetch(); }} /></Card>
      ) : (
        <BillingForm settings={settings.data} taxGroups={taxGroups.data} />
      )}
    </>
  );
}
