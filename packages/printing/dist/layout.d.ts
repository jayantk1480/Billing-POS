import type { PrintAlign, PrintDocument, PrintLine, PrintSize } from '@pos/types';
import type { InvoiceDto, KotDto, KotLayout, ReceiptLayout, RegisterDetailDto } from '@pos/validation';
/** Text as a thermal printer's built-in character set can show it. */
export declare function printable(text: string): string;
/** Breaks text into lines of at most `width` characters, at spaces where it can. */
export declare function wrap(text: string, width: number): string[];
interface Style {
    align?: PrintAlign;
    bold?: boolean;
    size?: PrintSize;
}
/** Collects the lines of one printout. */
export declare class Paper {
    readonly columns: number;
    readonly lines: PrintLine[];
    constructor(columns: number);
    private width;
    text(text: string, style?: Style): this;
    /** A label on the left and a value on the right of the same line. A long label wraps; the value stays on its last line. */
    row(left: string, right: string, style?: Omit<Style, 'align'>): this;
    /** Cells of fixed width; negative widths are right-aligned. The first cell wraps onto further lines. */
    cells(cells: [string, number][], style?: Omit<Style, 'align'>): this;
    rule(): this;
    feed(lines?: number): this;
    qr(data: string): this;
    done(options?: {
        copies?: number;
        openDrawer?: boolean;
    }): PrintDocument;
}
export declare function renderReceipt(invoice: InvoiceDto, layout: ReceiptLayout, columns: number, timeZone: string): PrintDocument;
export declare function renderKot(kot: KotDto, layout: KotLayout, columns: number, timeZone: string): PrintDocument;
export interface CreditNotePrint {
    sellerName: string;
    gstin: string | null;
    creditNoteNumber: string;
    invoiceNumber: string;
    createdAt: string;
    createdByName: string;
    method: string;
    amountPaise: number;
    taxablePaise: number;
    taxPaise: number;
    reason: string;
    customerName: string | null;
}
export declare function renderCreditNote(note: CreditNotePrint, columns: number, timeZone: string): PrintDocument;
export declare function renderRegisterReport(register: RegisterDetailDto, restaurantName: string, columns: number, timeZone: string): PrintDocument;
export declare function renderTestPage(printer: {
    name: string;
    connection: string;
    paperWidth: string;
}, restaurantName: string, columns: number, timeZone: string): PrintDocument;
export {};
//# sourceMappingURL=layout.d.ts.map