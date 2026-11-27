'use client';

import { GST_STATES } from '@pos/types';
import { Button, ErrorState, errorMessage, LoadingState, SelectField, TextField, toast, useApi, useFormState } from '@pos/ui';
import { signupSchema } from '@pos/validation';
import { useQuery } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

const STATES = Object.entries(GST_STATES).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
const GST_OPTIONS = [
  { value: 'REGULAR', label: 'Registered for GST' },
  { value: 'COMPOSITION', label: 'Composition scheme' },
  { value: 'UNREGISTERED', label: 'Not registered for GST' },
];

/** Shown after registering: the account exists, but only the emailed link opens it. */
function CheckYourEmail({ email }: { email: string }) {
  const api = useApi();
  const [sending, setSending] = useState(false);

  async function resend() {
    setSending(true);
    try {
      await api.signup.resend(email);
      toast.success('We have sent the link again.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><MailCheck className="size-6" /></span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-ink-900">Check your email</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">
        We sent a link to <span className="font-medium text-ink-900">{email}</span>. Open it to confirm your address and start your free trial.
        The link works for 24 hours.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">If this address already has an account, the email says so and shows how to sign in.</p>
      <Button variant="secondary" size="touch" className="mt-6 w-full" loading={sending} onClick={() => void resend()}>Send the link again</Button>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link></p>
    </div>
  );
}

export default function SignupPage() {
  const api = useApi();
  const options = useQuery({ queryKey: ['signup-options'], queryFn: api.signup.options });
  const form = useFormState({ restaurantName: '', ownerName: '', email: '', phone: '', password: '', stateCode: '', gstRegistration: 'REGULAR', gstin: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { values, set, errors } = form;
  const registered = values.gstRegistration !== 'UNREGISTERED';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = { ...values, gstin: registered ? values.gstin : '' };
    const done = await form.submit(signupSchema, payload, (data) => api.signup.register(data));
    if (done) setSentTo(values.email.trim().toLowerCase());
  }

  if (sentTo) return <CheckYourEmail email={sentTo} />;
  if (options.isPending) return <LoadingState />;
  if (options.isError) return <ErrorState message={errorMessage(options.error)} onRetry={() => void options.refetch()} />;
  if (!options.data.enabled) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Registration is by invitation</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">New restaurants are set up by our team at the moment. Contact us and we will create your account and email you a link to sign in.</p>
        <p className="mt-6 text-sm"><Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link></p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Register your restaurant</h1>
      <p className="mt-1.5 text-sm text-ink-500">Free for {options.data.trialDays} days. No card needed.</p>

      <div className="mt-8 space-y-4">
        <TextField label="Restaurant name" value={values.restaurantName} onChange={(v) => set('restaurantName', v)} error={errors.restaurantName} autoFocus maxLength={120} />
        <TextField label="Your name" autoComplete="name" value={values.ownerName} onChange={(v) => set('ownerName', v)} error={errors.ownerName} maxLength={80} />
        <TextField label="Email" type="email" autoComplete="email" value={values.email} onChange={(v) => set('email', v)} error={errors.email} hint="You sign in with this. We send a link to confirm it." />
        <TextField label="Mobile number" inputMode="numeric" autoComplete="tel-national" prefix="+91" value={values.phone} onChange={(v) => set('phone', v.replace(/\D/g, '').slice(0, 10))} error={errors.phone} />
        <TextField label="Password" type="password" autoComplete="new-password" value={values.password} onChange={(v) => set('password', v)} error={errors.password} hint="At least 10 characters. A short sentence works well." />
        <SelectField label="State" value={values.stateCode} onChange={(v) => set('stateCode', v)} error={errors.stateCode} placeholder="Choose a state" options={STATES} />
        <SelectField label="GST" value={values.gstRegistration} onChange={(v) => set('gstRegistration', v)} error={errors.gstRegistration} options={GST_OPTIONS} />
        {registered && (
          <TextField
            label="GSTIN" value={values.gstin} onChange={(v) => set('gstin', v.toUpperCase().replace(/\s/g, '').slice(0, 15))} error={errors.gstin}
            autoCapitalize="characters" spellCheck={false} hint="15 characters, printed on your bills."
          />
        )}
      </div>

      <Button type="submit" size="touch" className="mt-6 w-full" loading={form.submitting}>Create my account</Button>
      <p className="mt-4 text-center text-sm text-ink-500">
        Already registered? <Link href="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link>
      </p>
    </form>
  );
}
