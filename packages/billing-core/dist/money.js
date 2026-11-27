/** All amounts are integer paise. These helpers are the only place rupees and paise are converted. */
export function rupeesToPaise(rupees) {
    const text = typeof rupees === 'number' ? rupees.toFixed(2) : rupees.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(text))
        throw new Error(`Invalid rupee amount: ${rupees}`);
    const negative = text.startsWith('-');
    const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
    const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return negative ? -paise : paise;
}
export function formatINR(paise, options = {}) {
    const negative = paise < 0;
    const abs = Math.abs(paise);
    const whole = Math.floor(abs / 100).toString();
    const fraction = (abs % 100).toString().padStart(2, '0');
    // Indian digit grouping: last three digits, then groups of two.
    const head = whole.length > 3 ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '';
    const text = `${head}${whole.slice(-3)}.${fraction}`;
    return `${negative ? '-' : ''}${options.symbol === false ? '' : '₹'}${text}`;
}
/** Rounds half away from zero, the convention used for tax amounts. */
export function roundHalfUp(value) {
    return value < 0 ? -Math.round(-value) : Math.round(value);
}
/** amount × bps / 10000, rounded to the nearest paisa. */
export function applyBps(amountPaise, bps) {
    return roundHalfUp((amountPaise * bps) / 10000);
}
//# sourceMappingURL=money.js.map