const DAY_MS = 86_400_000;

/** Returns the calendar fields of an instant in the given IANA time zone. */
function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), minutes: get('hour') * 60 + get('minute') };
}

/**
 * The business date ("YYYY-MM-DD") an instant belongs to. An outlet whose day starts at 05:00
 * (cutoffMinutes = 300) books a 01:30 sale to the previous calendar date.
 */
export function businessDateOf(instant: Date, timeZone = 'Asia/Kolkata', cutoffMinutes = 0): string {
  const p = zonedParts(instant, timeZone);
  let date = Date.UTC(p.year, p.month - 1, p.day);
  if (p.minutes < cutoffMinutes) date -= DAY_MS;
  return new Date(date).toISOString().slice(0, 10);
}

/** Indian financial year of a business date, as "2627" for April 2026 to March 2027. */
export function financialYearOf(businessDate: string): string {
  const [year, month] = businessDate.split('-').map(Number) as [number, number];
  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}
