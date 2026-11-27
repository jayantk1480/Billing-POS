/** Calendar arithmetic on "YYYY-MM-DD" strings, in the restaurant's time zone. */
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

/** "12 Nov 2026" for a business day held as "YYYY-MM-DD". */
export const formatDay = (date: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date));
