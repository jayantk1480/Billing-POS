/** GST rule 46 limits an invoice number to 16 characters: letters, digits, "-" and "/". */
export const MAX_INVOICE_NUMBER_LENGTH = 16;

/** Builds a document number such as "A1/2627/000123". */
export function formatDocumentNumber(prefix: string, financialYear: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('Sequence must be a positive integer');
  if (!/^[A-Za-z0-9-]{1,8}$/.test(prefix)) throw new Error(`Invalid series prefix: ${prefix}`);
  const head = `${prefix}/${financialYear}/`;
  const width = Math.max(1, Math.min(6, MAX_INVOICE_NUMBER_LENGTH - head.length));
  const number = `${head}${String(sequence).padStart(width, '0')}`;
  if (number.length > MAX_INVOICE_NUMBER_LENGTH) {
    throw new Error(`Document number ${number} is longer than ${MAX_INVOICE_NUMBER_LENGTH} characters`);
  }
  return number;
}

/** The period key an order number is unique within, per the restaurant's reset setting. */
export function orderNumberPeriod(
  reset: 'DAILY' | 'FINANCIAL_YEAR' | 'NEVER',
  businessDate: string,
  financialYear: string,
): string {
  if (reset === 'DAILY') return businessDate;
  if (reset === 'FINANCIAL_YEAR') return `FY${financialYear}`;
  return 'ALL';
}
