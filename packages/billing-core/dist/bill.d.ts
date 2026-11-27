/**
 * Bill arithmetic for Indian GST. Pure functions: the POS uses them to show totals instantly,
 * and the API runs the same code as the authority when an order is saved or an invoice is issued.
 *
 * Amounts are integer paise, rates are basis points (500 = 5%).
 */
export type DiscountType = 'PERCENT' | 'AMOUNT';
export interface DiscountInput {
    type: DiscountType;
    /** Basis points for PERCENT, paise for AMOUNT. */
    value: number;
}
export interface TaxRates {
    /** Total GST rate. Split into equal CGST and SGST within a state; charged as IGST across states. */
    gstRateBps: number;
    cessRateBps: number;
}
export interface BillLineInput {
    id: string;
    quantity: number;
    /** Price of one unit, including the price of any modifiers. */
    unitPricePaise: number;
    /** True when the listed price already contains the tax. */
    priceIncludesTax: boolean;
    /** Null for an item that carries no tax. */
    tax: TaxRates | null;
    discount?: DiscountInput | null;
}
export interface BillInput {
    lines: BillLineInput[];
    /** A discount on the whole bill, spread across the lines in proportion to their value. */
    discount?: DiscountInput | null;
    /** False for unregistered and composition-scheme restaurants: no tax is charged at all. */
    taxApplicable: boolean;
    /** True when the place of supply is in a different state from the restaurant. */
    interState: boolean;
    serviceChargeBps?: number;
    /** Rates applied to the service charge, normally the restaurant's default tax group. */
    serviceChargeTax?: TaxRates | null;
    roundOff: 'NONE' | 'NEAREST_RUPEE';
}
export interface BillLine {
    id: string;
    quantity: number;
    unitPricePaise: number;
    /** quantity × unit price, as listed on the menu. */
    grossPaise: number;
    /** Line discount plus this line's share of the bill discount. */
    discountPaise: number;
    /** Value on which tax is charged. */
    taxablePaise: number;
    gstRateBps: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    taxPaise: number;
    /** What the customer pays for this line: taxable value plus tax. */
    totalPaise: number;
}
export type TaxComponent = 'CGST' | 'SGST' | 'IGST' | 'CESS';
export interface TaxSummaryRow {
    type: TaxComponent;
    rateBps: number;
    taxablePaise: number;
    amountPaise: number;
}
export interface Bill {
    lines: BillLine[];
    /** Sum of the listed line amounts, before any discount. */
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    taxPaise: number;
    /** The part of the tax that is added on top of listed prices (zero when every price includes tax). */
    taxAddedPaise: number;
    serviceChargePaise: number;
    roundOffPaise: number;
    /** gross − discount + service charge + tax added + round off. */
    totalPaise: number;
    /** One row per tax component and rate, as printed on the invoice and used in GST reports. */
    taxSummary: TaxSummaryRow[];
}
/** The amount a discount takes off `basePaise`, never more than the base itself. */
export declare function discountAmount(basePaise: number, discount: DiscountInput | null | undefined): number;
/** The discount as a share of the base in basis points, for checking against a cashier's limit. */
export declare function discountBps(basePaise: number, discount: DiscountInput | null | undefined): number;
/**
 * Splits `total` across `weights` in proportion, in whole paise, so the parts add up exactly.
 * Leftover paise go to the parts with the largest remainders.
 */
export declare function allocate(total: number, weights: number[]): number[];
export declare function computeBill(input: BillInput): Bill;
/** "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only". */
export declare function amountInWords(paise: number): string;
//# sourceMappingURL=bill.d.ts.map