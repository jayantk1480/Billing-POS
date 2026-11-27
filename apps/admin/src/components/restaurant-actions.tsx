'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, ConfirmDialog, Dialog, errorMessage, TextAreaField, TextField, toast, useFormState } from '@pos/ui';
import { type PlatformRestaurantDetailDto, setPaidUntilSchema, setTrialSchema, suspendRestaurantSchema } from '@pos/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarClock, IndianRupee, Mail, RotateCcw } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { keys, platform } from '@/lib/api';
import { addDays, addYears, dayOf, formatDay, todayIso } from '@/lib/dates';

interface DialogProps {
  restaurant: PlatformRestaurantDetailDto;
  onClose: () => void;
}

/**
 * What every action does once the server has answered: the answer is the restaurant as it now is, so the
 * page shows it at once, and the list and the counts on the home page are fetched again.
 */
function useUpdated(id: string) {
  const queryClient = useQueryClient();
  return {
    apply(detail: PlatformRestaurantDetailDto) {
      queryClient.setQueryData(keys.restaurant(id), detail);
      void queryClient.invalidateQueries({ queryKey: keys.restaurants });
      void queryClient.invalidateQueries({ queryKey: keys.overview });
    },
    /** A "conflict" answer means someone else changed the restaurant meanwhile: show how it stands now. */
    reloadIfChanged(error: unknown) {
      if (error instanceof ApiRequestError && error.status === 409) void queryClient.invalidateQueries({ queryKey: keys.restaurant(id) });
    },
  };
}

/** The errors for fields left empty, worded for this screen; null when the date and the note are both filled in. */
function missing(date: { key: string; value: string } | null, note: string): Record<string, string> | null {
  const errors: Record<string, string> = {};
  if (date && !date.value) errors[date.key] = 'Choose a date';
  if (!note.trim()) errors.note = 'Note is required';
  return Object.keys(errors).length > 0 ? errors : null;
}

function TrialDialog({ restaurant, onClose }: DialogProps) {
  const updated = useUpdated(restaurant.id);
  const { trialEndsAt } = restaurant.subscription;
  const form = useFormState({ trialEndsOn: trialEndsAt ? dayOf(trialEndsAt) : addDays(todayIso(), 14), note: '' });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const empty = missing({ key: 'trialEndsOn', value: values.trialEndsOn }, values.note);
    if (empty) return form.setErrors(empty);
    const result: { detail: PlatformRestaurantDetailDto | null } = { detail: null };
    const saved = await form.submit(setTrialSchema, values, async (data) => {
      result.detail = await platform.restaurants.setTrial(restaurant.id, data);
    });
    if (!saved || !result.detail) return;
    updated.apply(result.detail);
    toast.success(`The trial now ends on ${formatDay(values.trialEndsOn)}`);
    onClose();
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title="Change trial end"
      description={`Give ${restaurant.name} more time on the free trial, or less.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="trial-form" loading={form.submitting}>Save trial end</Button>
        </>
      }
    >
      <form id="trial-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField
          label="Trial ends on" type="date" value={values.trialEndsOn} onChange={(v) => set('trialEndsOn', v)} error={errors.trialEndsOn}
          hint="The trial runs to the end of this day, India time."
        />
        <TextAreaField
          label="Note" value={values.note} onChange={(v) => set('note', v)} error={errors.note} maxLength={300} autoFocus
          placeholder="Owner asked for two more weeks to finish setting up the menu" hint="Why the trial is being moved. Kept in the restaurant's audit log."
        />
      </form>
    </Dialog>
  );
}

function PaymentDialog({ restaurant, onClose }: DialogProps) {
  const updated = useUpdated(restaurant.id);
  const today = todayIso();
  const { paidUntil } = restaurant.subscription;
  // A renewal runs on from the day already paid for; after a gap, or the first time, it runs from today.
  const form = useFormState({ paidUntil: addYears(paidUntil && paidUntil >= today ? paidUntil : today, 1), note: '' });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const empty = missing({ key: 'paidUntil', value: values.paidUntil }, values.note);
    if (empty) return form.setErrors(empty);
    const result: { detail: PlatformRestaurantDetailDto | null } = { detail: null };
    const saved = await form.submit(setPaidUntilSchema, values, async (data) => {
      result.detail = await platform.restaurants.setPaidUntil(restaurant.id, data);
    });
    if (!saved || !result.detail) return;
    updated.apply(result.detail);
    toast.success(`Payment recorded. ${restaurant.name} is paid until ${formatDay(values.paidUntil)}.`);
    onClose();
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title="Record payment"
      description={paidUntil ? `${restaurant.name} is paid until ${formatDay(paidUntil)} at present.` : `${restaurant.name} has no paid period yet.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="payment-form" loading={form.submitting}>Record payment</Button>
        </>
      }
    >
      <form id="payment-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField
          label="Paid until" type="date" value={values.paidUntil} onChange={(v) => set('paidUntil', v)} error={errors.paidUntil}
          hint="The last day that is paid for."
        />
        <TextAreaField
          label="Note" value={values.note} onChange={(v) => set('note', v)} error={errors.note} maxLength={300} autoFocus
          placeholder="UPI ref 4411, ₹12,000 for one year" hint="How the payment was made. Kept in the restaurant's audit log."
        />
      </form>
    </Dialog>
  );
}

function RemovePaidDialog({ restaurant, onClose }: DialogProps) {
  const updated = useUpdated(restaurant.id);
  const form = useFormState({ note: '' });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const empty = missing(null, values.note);
    if (empty) return form.setErrors(empty);
    const result: { detail: PlatformRestaurantDetailDto | null } = { detail: null };
    const saved = await form.submit(setPaidUntilSchema, { paidUntil: null, note: values.note }, async (data) => {
      result.detail = await platform.restaurants.setPaidUntil(restaurant.id, data);
    });
    if (!saved || !result.detail) return;
    updated.apply(result.detail);
    toast.success('Paid period removed');
    onClose();
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title="Remove paid period"
      description={restaurant.subscription.paidUntil ? `${restaurant.name} is paid until ${formatDay(restaurant.subscription.paidUntil)} at present.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button variant="danger" type="submit" form="remove-paid-form" loading={form.submitting}>Remove paid period</Button>
        </>
      }
    >
      <form id="remove-paid-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          Without a paid period the restaurant depends on its trial again. If the trial is over it becomes expired: people there can still view and export, but cannot change anything.
        </p>
        <TextAreaField
          label="Note" value={values.note} onChange={(v) => set('note', v)} error={errors.note} maxLength={300} autoFocus
          placeholder="Recorded by mistake against the wrong restaurant" hint="Why the paid period is being removed. Kept in the restaurant's audit log."
        />
      </form>
    </Dialog>
  );
}

function SuspendDialog({ restaurant, onClose }: DialogProps) {
  const updated = useUpdated(restaurant.id);
  const form = useFormState({ reason: '' });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result: { detail: PlatformRestaurantDetailDto | null } = { detail: null };
    const saved = await form.submit(suspendRestaurantSchema, values, async (data) => {
      try {
        result.detail = await platform.restaurants.suspend(restaurant.id, data.reason);
      } catch (error) {
        updated.reloadIfChanged(error);
        throw error;
      }
    });
    if (!saved || !result.detail) return;
    updated.apply(result.detail);
    toast.success(`${restaurant.name} is suspended`);
    onClose();
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={`Suspend ${restaurant.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button variant="danger" type="submit" form="suspend-form" loading={form.submitting}>Suspend restaurant</Button>
        </>
      }
    >
      <form id="suspend-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
          Everyone at this restaurant is signed out and cannot sign in until it is restored. Its data is kept.
        </p>
        <TextAreaField
          label="Reason" value={values.reason} onChange={(v) => set('reason', v)} error={errors.reason} maxLength={300} autoFocus
          hint="Kept in the restaurant's audit log and shown on this page."
        />
      </form>
    </Dialog>
  );
}

/** "Change trial end", "Record payment" and "Remove paid period": how long the restaurant may be used. */
export function SubscriptionActions({ restaurant }: { restaurant: PlatformRestaurantDetailDto }) {
  const [open, setOpen] = useState<'trial' | 'payment' | 'remove' | null>(null);
  const close = () => setOpen(null);
  return (
    <>
      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
        <Button variant="secondary" size="sm" onClick={() => setOpen('trial')}><CalendarClock className="size-4" aria-hidden /> Change trial end</Button>
        <Button variant="secondary" size="sm" onClick={() => setOpen('payment')}><IndianRupee className="size-4" aria-hidden /> Record payment</Button>
        {restaurant.subscription.paidUntil && <Button variant="ghost" size="sm" onClick={() => setOpen('remove')}>Remove paid period</Button>}
      </div>
      {open === 'trial' && <TrialDialog restaurant={restaurant} onClose={close} />}
      {open === 'payment' && <PaymentDialog restaurant={restaurant} onClose={close} />}
      {open === 'remove' && <RemovePaidDialog restaurant={restaurant} onClose={close} />}
    </>
  );
}

/** "Email owner a password link" and "Suspend" or "Restore": who can get in. */
export function AccessActions({ restaurant }: { restaurant: PlatformRestaurantDetailDto }) {
  const updated = useUpdated(restaurant.id);
  const [open, setOpen] = useState<'invite' | 'suspend' | 'restore' | null>(null);
  const close = () => setOpen(null);
  const suspended = restaurant.subscription.status === 'SUSPENDED';

  const invite = useMutation({
    mutationFn: () => platform.restaurants.invite(restaurant.id),
    onSuccess: () => {
      toast.success(`A link to choose a password was emailed to ${restaurant.ownerEmail ?? 'the owner'}`);
      close();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      close();
    },
  });
  const restore = useMutation({
    mutationFn: () => platform.restaurants.reactivate(restaurant.id),
    onSuccess: (detail) => {
      updated.apply(detail);
      toast.success(`${restaurant.name} is restored. People there can sign in again.`);
      close();
    },
    onError: (error) => {
      updated.reloadIfChanged(error);
      toast.error(errorMessage(error));
      close();
    },
  });
  const busy = invite.isPending || restore.isPending;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {/* Without an owner account there is nobody to send the link to. */}
        {restaurant.ownerEmail && (
          <Button variant="secondary" onClick={() => setOpen('invite')} disabled={busy}><Mail className="size-4" aria-hidden /> Email owner a password link</Button>
        )}
        {suspended ? (
          <Button onClick={() => setOpen('restore')} disabled={busy}><RotateCcw className="size-4" aria-hidden /> Restore</Button>
        ) : (
          <Button variant="danger" onClick={() => setOpen('suspend')} disabled={busy}><Ban className="size-4" aria-hidden /> Suspend</Button>
        )}
      </div>

      <ConfirmDialog
        open={open === 'invite'} onClose={close} onConfirm={() => invite.mutate()} loading={invite.isPending}
        title="Email owner a password link" confirmLabel="Send the link"
        message={
          <>
            <span className="font-medium text-ink-900">{restaurant.ownerEmail}</span> gets a link to choose a password. It works once, for 7 days, and replaces any
            earlier link that was not used. A password they already have keeps working until they choose a new one.
          </>
        }
      />
      <ConfirmDialog
        open={open === 'restore'} onClose={close} onConfirm={() => restore.mutate()} loading={restore.isPending}
        title={`Restore ${restaurant.name}`} confirmLabel="Restore"
        message="People at this restaurant will be able to sign in again. Its trial end and paid period did not change while it was suspended."
      />
      {open === 'suspend' && <SuspendDialog restaurant={restaurant} onClose={close} />}
    </>
  );
}
