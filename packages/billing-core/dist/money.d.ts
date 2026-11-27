/** All amounts are integer paise. These helpers are the only place rupees and paise are converted. */
export declare function rupeesToPaise(rupees: number | string): number;
export declare function formatINR(paise: number, options?: {
    symbol?: boolean;
}): string;
/** Rounds half away from zero, the convention used for tax amounts. */
export declare function roundHalfUp(value: number): number;
/** amount × bps / 10000, rounded to the nearest paisa. */
export declare function applyBps(amountPaise: number, bps: number): number;
//# sourceMappingURL=money.d.ts.map