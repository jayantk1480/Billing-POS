import { applyBps, roundHalfUp } from './money.js';

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
export function discountAmount(basePaise: number, discount: DiscountInput | null | undefined): number {
  if (!discount || discount.value <= 0 || basePaise <= 0) return 0;
  const amount = discount.type === 'PERCENT' ? applyBps(basePaise, discount.value) : discount.value;
  return Math.min(Math.max(amount, 0), basePaise);
}

/** The discount as a share of the base in basis points, for checking against a cashier's limit. */
export function discountBps(basePaise: number, discount: DiscountInput | null | undefined): number {
  if (basePaise <= 0) return 0;
  return Math.round((discountAmount(basePaise, discount) * 10_000) / basePaise);
}

/**
 * Splits `total` across `weights` in proportion, in whole paise, so the parts add up exactly.
 * Leftover paise go to the parts with the largest remainders.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index]! += 1;
    left -= 1;
  }
  return parts;
}

interface TaxSplit {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

/**
 * Tax on an amount. For a tax-inclusive amount the taxable value is worked backwards, so the
 * customer pays exactly the listed price. CGST and SGST are always equal to the paisa.
 */
function taxOn(amountPaise: number, includesTax: boolean, rates: TaxRates | null, interState: boolean): TaxSplit {
  if (!rates || (rates.gstRateBps === 0 && rates.cessRateBps === 0) || amountPaise <= 0) {
    return { taxable: Math.max(amountPaise, 0), cgst: 0, sgst: 0, igst: 0, cess: 0 };
  }
  const base = includesTax
    ? roundHalfUp((amountPaise * 10_000) / (10_000 + rates.gstRateBps + rates.cessRateBps))
    : amountPaise;
  const half = interState ? 0 : applyBps(base, rates.gstRateBps / 2);
  const igst = interState ? applyBps(base, rates.gstRateBps) : 0;
  const cess = applyBps(base, rates.cessRateBps);
  // For an inclusive price, any rounding difference stays in the taxable value.
  const taxable = includesTax ? amountPaise - 2 * half - igst - cess : base;
  return { taxable, cgst: half, sgst: half, igst, cess };
}

export function computeBill(input: BillInput): Bill {
  const afterLineDiscount = input.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new Error(`Line ${line.id}: quantity must be a positive whole number`);
    if (!Number.isInteger(line.unitPricePaise) || line.unitPricePaise < 0) throw new Error(`Line ${line.id}: price must be whole paise`);
    const gross = line.quantity * line.unitPricePaise;
    const lineDiscount = discountAmount(gross, line.discount);
    return { line, gross, lineDiscount, net: gross - lineDiscount };
  });

  const netTotal = afterLineDiscount.reduce((sum, entry) => sum + entry.net, 0);
  const billDiscount = discountAmount(netTotal, input.discount);
  const shares = allocate(billDiscount, afterLineDiscount.map((entry) => entry.net));

  const summary = new Map<string, TaxSummaryRow>();
  const addToSummary = (type: TaxComponent, rateBps: number, taxable: number, amount: number) => {
    if (amount === 0 && rateBps === 0) return;
    const key = `${type}:${rateBps}`;
    const row = summary.get(key) ?? { type, rateBps, taxablePaise: 0, amountPaise: 0 };
    row.taxablePaise += taxable;
    row.amountPaise += amount;
    summary.set(key, row);
  };
  const summarise = (split: TaxSplit, rates: TaxRates | null) => {
    if (!rates) return;
    if (input.interState) addToSummary('IGST', rates.gstRateBps, split.taxable, split.igst);
    else {
      addToSummary('CGST', rates.gstRateBps / 2, split.taxable, split.cgst);
      addToSummary('SGST', rates.gstRateBps / 2, split.taxable, split.sgst);
    }
    if (rates.cessRateBps > 0) addToSummary('CESS', rates.cessRateBps, split.taxable, split.cess);
  };

  let taxAdded = 0;
  const lines: BillLine[] = afterLineDiscount.map(({ line, gross, lineDiscount, net }, index) => {
    const discount = lineDiscount + shares[index]!;
    const rates = input.taxApplicable ? line.tax : null;
    const split = taxOn(net - shares[index]!, line.priceIncludesTax, rates, input.interState);
    const tax = split.cgst + split.sgst + split.igst + split.cess;
    if (rates && !line.priceIncludesTax) taxAdded += tax;
    summarise(split, rates);
    return {
      id: line.id,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      grossPaise: gross,
      discountPaise: discount,
      taxablePaise: split.taxable,
      gstRateBps: rates?.gstRateBps ?? 0,
      cgstPaise: split.cgst,
      sgstPaise: split.sgst,
      igstPaise: split.igst,
      cessPaise: split.cess,
      taxPaise: tax,
      totalPaise: split.taxable + tax,
    };
  });

  const sum = (pick: (line: BillLine) => number) => lines.reduce((total, line) => total + pick(line), 0);
  const itemsTaxable = sum((line) => line.taxablePaise);

  // Service charge is part of the value of the supply, so it is taxed too.
  const serviceCharge = applyBps(itemsTaxable, input.serviceChargeBps ?? 0);
  const serviceRates = input.taxApplicable ? (input.serviceChargeTax ?? null) : null;
  const serviceSplit = taxOn(serviceCharge, false, serviceRates, input.interState);
  const serviceTax = serviceSplit.cgst + serviceSplit.sgst + serviceSplit.igst + serviceSplit.cess;
  if (serviceCharge > 0) summarise(serviceSplit, serviceRates);
  taxAdded += serviceTax;

  const grossPaise = sum((line) => line.grossPaise);
  const discountPaise = sum((line) => line.discountPaise);
  const beforeRounding = grossPaise - discountPaise + serviceCharge + taxAdded;
  const totalPaise = input.roundOff === 'NEAREST_RUPEE' ? roundHalfUp(beforeRounding / 100) * 100 : beforeRounding;

  const order: TaxComponent[] = ['CGST', 'SGST', 'IGST', 'CESS'];
  return {
    lines,
    grossPaise,
    discountPaise,
    taxablePaise: itemsTaxable + serviceCharge,
    cgstPaise: sum((line) => line.cgstPaise) + serviceSplit.cgst,
    sgstPaise: sum((line) => line.sgstPaise) + serviceSplit.sgst,
    igstPaise: sum((line) => line.igstPaise) + serviceSplit.igst,
    cessPaise: sum((line) => line.cessPaise) + serviceSplit.cess,
    taxPaise: sum((line) => line.taxPaise) + serviceTax,
    taxAddedPaise: taxAdded,
    serviceChargePaise: serviceCharge,
    roundOffPaise: totalPaise - beforeRounding,
    totalPaise,
    taxSummary: [...summary.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.rateBps - b.rateBps),
  };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const tail = rest < 20 ? ONES[rest]! : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? ` ${ONES[rest % 10]}` : ''}`;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', tail].filter(Boolean).join(' ');
}

/** "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only". */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const fraction = Math.abs(paise) % 100;
  const groups: [number, string][] = [
    [Math.floor(rupees / 10_000_000), 'Crore'],
    [Math.floor(rupees / 100_000) % 100, 'Lakh'],
    [Math.floor(rupees / 1000) % 100, 'Thousand'],
    [rupees % 1000, ''],
  ];
  const words = groups.filter(([value]) => value > 0).map(([value, unit]) => `${belowThousand(value)}${unit ? ` ${unit}` : ''}`).join(' ');
  return `Rupees ${words || 'Zero'}${fraction ? ` and ${belowThousand(fraction)} Paise` : ''} Only`;
}
