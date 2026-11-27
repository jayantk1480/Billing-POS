'use client';

import { Button, Card, CardHeader, cn, errorMessage, toast, useApi, useAuth } from '@pos/ui';
import type { OnboardingDto } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { POS_URL } from '@/lib/api';

type StepKey = keyof OnboardingDto['steps'];
const STEPS: { key: StepKey; title: string; detail: string; href: string; external?: boolean }[] = [
  { key: 'details', title: 'Add your address', detail: 'It is printed at the top of every bill, with your GSTIN and FSSAI number.', href: '/settings/restaurant' },
  { key: 'menu', title: 'Add your menu', detail: 'Categories and items with their prices. You can paste many items at once from a spreadsheet.', href: '/menu/products' },
  { key: 'tables', title: 'Add your tables', detail: 'Only if guests eat in. Skip this for takeaway and delivery.', href: '/floor' },
  { key: 'staff', title: 'Add your staff', detail: 'Give each cashier their own sign-in for the billing screen.', href: '/team/users' },
  { key: 'firstBill', title: 'Make your first bill', detail: 'Open the billing screen and sign in with the same email and password.', href: POS_URL, external: true },
];

/**
 * What a new restaurant still has to do before it can trade, ticked off as it is done. The list goes away
 * once everything is done or the owner hides it; restaurants that existed before never see it.
 */
export function GettingStarted() {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  // Asked afresh each time the dashboard opens: the owner has usually just come back from doing one of the steps.
  const onboarding = useQuery({ queryKey: ['onboarding'], queryFn: api.onboarding.get, staleTime: 0, refetchOnMount: 'always' });
  const [hiding, setHiding] = useState(false);

  const data = onboarding.data;
  if (!data || data.dismissed) return null;
  const done = STEPS.filter((step) => data.steps[step.key]).length;
  // Tables are optional, so they do not hold the list open.
  if (STEPS.every((step) => data.steps[step.key] || step.key === 'tables')) return null;

  async function hide() {
    setHiding(true);
    try {
      queryClient.setQueryData(['onboarding'], await api.onboarding.dismiss());
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setHiding(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader
        title="Getting started" description={done + ' of ' + STEPS.length + ' done'}
        action={can('settings.manage') ? <Button variant="ghost" size="sm" loading={hiding} onClick={() => void hide()}>Hide this list</Button> : undefined}
      />
      <ol className="divide-y divide-line">
        {STEPS.map((step) => {
          const complete = data.steps[step.key];
          const body = (
            <>
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold', complete ? 'border-green-600 bg-green-600 text-white' : 'border-line text-ink-500')} aria-hidden>
                {complete ? <Check className="size-4" /> : STEPS.indexOf(step) + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-sm font-medium', complete ? 'text-ink-500 line-through' : 'text-ink-900')}>{step.title}</span>
                <span className="block text-sm text-ink-500">{step.detail}</span>
              </span>
              <span className="sr-only">{complete ? 'Done' : 'To do'}</span>
              {!complete && <ChevronRight className="size-4 shrink-0 text-ink-300" aria-hidden />}
            </>
          );
          const className = 'flex items-center gap-3 px-5 py-3.5 hover:bg-canvas';
          return (
            <li key={step.key}>
              {step.external
                ? <a href={step.href} target="_blank" rel="noreferrer" className={className}>{body}</a>
                : <Link href={step.href} className={className}>{body}</Link>}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
