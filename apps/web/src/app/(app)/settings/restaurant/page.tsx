'use client';

import { GST_STATES } from '@pos/types';
import { Button, Card, CardHeader, ErrorState, errorMessage, LoadingState, PageHeader, SelectField, TextField, toast, useApi, useFormState } from '@pos/ui';
import { type RestaurantDto, updateRestaurantSchema } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';

const STATE_OPTIONS = Object.entries(GST_STATES)
  .map(([code, name]) => ({ value: code, label: `${name} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label));

function RestaurantForm({ restaurant }: { restaurant: RestaurantDto }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useFormState({
    name: restaurant.name,
    legalName: restaurant.legalName ?? '',
    gstin: restaurant.gstin ?? '',
    fssaiNumber: restaurant.fssaiNumber ?? '',
    phone: restaurant.phone ?? '',
    email: restaurant.email ?? '',
    addressLine1: restaurant.addressLine1 ?? '',
    addressLine2: restaurant.addressLine2 ?? '',
    city: restaurant.city ?? '',
    stateCode: restaurant.stateCode,
    pincode: restaurant.pincode ?? '',
  });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await form.submit(updateRestaurantSchema, values, async (data) => {
      queryClient.setQueryData(['restaurant'], await api.restaurant.update(data));
      // The sidebar shows the restaurant name from the signed-in user.
      await api.auth.reloadUser();
    });
    if (saved) toast.success('Restaurant details saved');
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <Card>
        <CardHeader title="Business" description="Printed at the top of every bill." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <TextField label="Restaurant name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} />
          <TextField label="Legal name" value={values.legalName} onChange={(v) => set('legalName', v)} error={errors.legalName} hint="As registered for GST, if different" />
          <TextField label="Phone" type="tel" value={values.phone} onChange={(v) => set('phone', v)} error={errors.phone} />
          <TextField label="Email" type="email" value={values.email} onChange={(v) => set('email', v)} error={errors.email} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Registration" description="The state decides whether a sale is charged CGST and SGST or IGST." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <SelectField label="State" value={values.stateCode} onChange={(v) => set('stateCode', v)} error={errors.stateCode} options={STATE_OPTIONS} />
          <TextField
            label="GSTIN" value={values.gstin} onChange={(v) => set('gstin', v.toUpperCase())} error={errors.gstin} maxLength={15}
            hint="15 characters, starting with the state code" className="font-mono"
          />
          <TextField label="FSSAI licence number" inputMode="numeric" value={values.fssaiNumber} onChange={(v) => set('fssaiNumber', v)} error={errors.fssaiNumber} maxLength={14} hint="14 digits" />
        </div>
      </Card>
      <Card>
        <CardHeader title="Address" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <TextField className="sm:col-span-2" label="Address line 1" value={values.addressLine1} onChange={(v) => set('addressLine1', v)} error={errors.addressLine1} />
          <TextField className="sm:col-span-2" label="Address line 2" value={values.addressLine2} onChange={(v) => set('addressLine2', v)} error={errors.addressLine2} />
          <TextField label="City" value={values.city} onChange={(v) => set('city', v)} error={errors.city} />
          <TextField label="PIN code" inputMode="numeric" value={values.pincode} onChange={(v) => set('pincode', v)} error={errors.pincode} maxLength={6} />
        </div>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" loading={form.submitting}>Save changes</Button>
      </div>
    </form>
  );
}

export default function RestaurantSettingsPage() {
  const api = useApi();
  const restaurant = useQuery({ queryKey: ['restaurant'], queryFn: api.restaurant.get });
  return (
    <>
      <PageHeader title="Restaurant" description="Business details used on bills and tax invoices." />
      {restaurant.isPending ? (
        <Card><LoadingState /></Card>
      ) : restaurant.isError ? (
        <Card><ErrorState message={errorMessage(restaurant.error)} onRetry={() => void restaurant.refetch()} /></Card>
      ) : (
        <RestaurantForm restaurant={restaurant.data} />
      )}
    </>
  );
}
