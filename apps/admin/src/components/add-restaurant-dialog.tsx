'use client';

import { ApiRequestError } from '@pos/api-client';
import { GST_STATES } from '@pos/types';
import { Button, Dialog, SelectField, TextField, useFormState } from '@pos/ui';
import { platformCreateRestaurantSchema, type PlatformRestaurantDetailDto } from '@pos/validation';
import { type FormEvent } from 'react';
import { platform } from '@/lib/api';
import { GST_REGISTRATION } from '@/lib/labels';

const STATE_OPTIONS = Object.entries(GST_STATES)
  .map(([value, label]) => ({ value, label }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en-IN'));
const GST_OPTIONS = (['REGULAR', 'COMPOSITION', 'UNREGISTERED'] as const).map((value) => ({ value, label: GST_REGISTRATION[value] }));
const DAYS_ERROR = 'Enter a whole number from 0 to 365';

/** Whole days from the text of the field, or null when it is not a number the API accepts. */
function trialDaysOf(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days <= 365 ? days : null;
}

/**
 * Sets a restaurant up for someone who asked us to. The owner is emailed a link to choose a password,
 * so no password passes through this app.
 */
export function AddRestaurantDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (restaurant: PlatformRestaurantDetailDto) => void }) {
  const form = useFormState({
    restaurantName: '', ownerName: '', email: '', phone: '', stateCode: '', gstRegistration: 'REGULAR', gstin: '', trialDays: '14',
  });
  const { values, set, errors } = form;
  const registered = values.gstRegistration !== 'UNREGISTERED';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const days = trialDaysOf(values.trialDays);
    const payload = { ...values, gstin: registered ? values.gstin : null, trialDays: days ?? 0 };
    if (days === null) {
      // Show this next to its field together with whatever else is wrong, rather than one problem at a time.
      const parsed = platformCreateRestaurantSchema.safeParse(payload);
      const next: Record<string, string> = { trialDays: DAYS_ERROR };
      if (!parsed.success) for (const issue of parsed.error.issues) next[issue.path.join('.')] ??= issue.message;
      form.setErrors(next);
      return;
    }
    const result: { created: PlatformRestaurantDetailDto | null; emailTaken: string | null } = { created: null, emailTaken: null };
    const saved = await form.submit(platformCreateRestaurantSchema, payload, async (data) => {
      try {
        result.created = await platform.restaurants.create(data);
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'EMAIL_TAKEN') result.emailTaken = error.message;
        throw error;
      }
    });
    // The form reports this as a toast; it also belongs next to the field it is about.
    if (result.emailTaken) form.setErrors({ email: result.emailTaken });
    if (saved && result.created) onCreated(result.created);
  }

  return (
    <Dialog
      open onClose={onClose} title="Add restaurant"
      description="Sets the restaurant up and emails the owner a link to choose a password. The link works for 7 days."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="add-restaurant-form" loading={form.submitting}>Add restaurant</Button>
        </>
      }
    >
      <form id="add-restaurant-form" onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
        <TextField label="Restaurant name" value={values.restaurantName} onChange={(v) => set('restaurantName', v)} error={errors.restaurantName} autoFocus className="sm:col-span-2" />
        {/* The shared schema words this message for someone signing up themselves. */}
        <TextField label="Owner's name" value={values.ownerName} onChange={(v) => set('ownerName', v)} error={errors.ownerName?.replace('Your name', "Owner's name")} autoComplete="off" />
        <TextField label="Owner's email" type="email" value={values.email} onChange={(v) => set('email', v)} error={errors.email} autoComplete="off" hint="The password link is sent here" />
        <TextField label="Mobile (optional)" type="tel" inputMode="numeric" value={values.phone} onChange={(v) => set('phone', v)} error={errors.phone} maxLength={10} autoComplete="off" placeholder="10 digits" />
        <SelectField label="State" value={values.stateCode} onChange={(v) => set('stateCode', v)} error={errors.stateCode} options={STATE_OPTIONS} placeholder="Choose a state" />
        <SelectField label="GST registration" value={values.gstRegistration} onChange={(v) => set('gstRegistration', v)} error={errors.gstRegistration} options={GST_OPTIONS} />
        {registered && (
          <TextField
            label="GSTIN" value={values.gstin} onChange={(v) => set('gstin', v.toUpperCase())} error={errors.gstin} maxLength={15} autoComplete="off"
            hint="15 characters. The first two digits are the state's code."
          />
        )}
        <TextField
          label="Free trial days" type="number" inputMode="numeric" min={0} max={365} step={1} value={values.trialDays}
          onChange={(v) => set('trialDays', v)} error={errors.trialDays} hint="0 for no time limit"
        />
      </form>
    </Dialog>
  );
}
