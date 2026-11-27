import { rupeesToPaise } from '@pos/billing-core';

/** Text for a rupee input: "260" or "260.50". */
export function paiseToInput(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** Paise from a rupee input, or NaN when the text is not a valid amount (the schema then reports it). */
export function inputToPaise(text: string): number {
  try {
    return rupeesToPaise(text);
  } catch {
    return Number.NaN;
  }
}

/** "5" or "2.5" for a rate held in basis points. */
export function bpsToInput(bps: number): string {
  return String(bps / 100);
}

export function inputToBps(text: string): number {
  if (text.trim() === '') return Number.NaN;
  // Rounded to avoid 2.55 * 100 = 254.99999999999997.
  return Math.round(Number(text) * 100 * 1e6) / 1e6;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Never';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/** How a customer is shown wherever there is one line for them: the mobile number, which identifies them, then the name. */
export function customerLabel(phone: string | null | undefined, name: string | null | undefined): string | null {
  if (phone) return name ? `${phone} · ${name}` : phone;
  return name ?? null;
}
