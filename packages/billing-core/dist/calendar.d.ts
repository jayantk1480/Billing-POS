/**
 * The business date ("YYYY-MM-DD") an instant belongs to. An outlet whose day starts at 05:00
 * (cutoffMinutes = 300) books a 01:30 sale to the previous calendar date.
 */
export declare function businessDateOf(instant: Date, timeZone?: string, cutoffMinutes?: number): string;
/** Indian financial year of a business date, as "2627" for April 2026 to March 2027. */
export declare function financialYearOf(businessDate: string): string;
//# sourceMappingURL=calendar.d.ts.map