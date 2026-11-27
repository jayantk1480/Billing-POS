/** Dates are shown, and calendar days counted, in India time: that is where the restaurants are. */
const INDIA = 'Asia/Kolkata';

/** Today in India as "YYYY-MM-DD". */
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: INDIA }).format(new Date());

/** The India calendar day, "YYYY-MM-DD", that a timestamp falls on. */
export const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: INDIA }).format(new Date(iso));

export const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

/** The same day a number of years on; 29 February becomes 28 February in a year that has none. */
export function addYears(date: string, years: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year + years, month - 1, day));
  if (next.getUTCMonth() !== month - 1) next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
}

/** "12 Nov 2026" for a day held as "YYYY-MM-DD". */
export const formatDay = (date: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date));

/** "12 Nov 2026" for a timestamp: the day it falls on in India. */
export const formatDayOf = (iso: string) => formatDay(dayOf(iso));
