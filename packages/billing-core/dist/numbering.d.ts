/** GST rule 46 limits an invoice number to 16 characters: letters, digits, "-" and "/". */
export declare const MAX_INVOICE_NUMBER_LENGTH = 16;
/** Builds a document number such as "A1/2627/000123". */
export declare function formatDocumentNumber(prefix: string, financialYear: string, sequence: number): string;
/** The period key an order number is unique within, per the restaurant's reset setting. */
export declare function orderNumberPeriod(reset: 'DAILY' | 'FINANCIAL_YEAR' | 'NEVER', businessDate: string, financialYear: string): string;
//# sourceMappingURL=numbering.d.ts.map