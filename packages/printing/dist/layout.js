import { formatINR } from '@pos/billing-core';
/**
 * Lays printouts out as lines of fixed-width text for a thermal printer. The printer is sent plain
 * characters, so anything it cannot print (the rupee sign, accents, other scripts) is replaced here.
 */
const REPLACEMENTS = [
    [/₹\s?/g, 'Rs.'], [/[×✕]/g, 'x'], [/[–—]/g, '-'], [/[‘’]/g, "'"], [/[“”]/g, '"'], [/[·•]/g, '-'], [/»/g, '>'], [/…/g, '...'],
    // Intl puts narrow and non-breaking spaces into dates and amounts.
    [/[   ]/g, ' '],
];
/** Text as a thermal printer's built-in character set can show it. */
export function printable(text) {
    let result = text;
    for (const [pattern, replacement] of REPLACEMENTS)
        result = result.replace(pattern, replacement);
    return result.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim();
}
/** Breaks text into lines of at most `width` characters, at spaces where it can. */
export function wrap(text, width) {
    const lines = [];
    let current = '';
    for (const word of text.split(' ')) {
        let rest = word;
        while (rest.length > width) {
            if (current) {
                lines.push(current);
                current = '';
            }
            lines.push(rest.slice(0, width));
            rest = rest.slice(width);
        }
        if (!current)
            current = rest;
        else if (current.length + 1 + rest.length <= width)
            current += ' ' + rest;
        else {
            lines.push(current);
            current = rest;
        }
    }
    if (current || lines.length === 0)
        lines.push(current);
    return lines;
}
/** Collects the lines of one printout. */
export class Paper {
    columns;
    lines = [];
    constructor(columns) {
        this.columns = columns;
    }
    width(size) {
        return size === 'wide' || size === 'large' ? Math.floor(this.columns / 2) : this.columns;
    }
    text(text, style = {}) {
        const indent = /^ */.exec(text)[0];
        for (const line of wrap(printable(text), this.width(style.size) - indent.length))
            this.lines.push({ kind: 'text', text: indent + line, ...style });
        return this;
    }
    /** A label on the left and a value on the right of the same line. A long label wraps; the value stays on its last line. */
    row(left, right, style = {}) {
        const width = this.width(style.size);
        const value = printable(right);
        // Leading spaces indent the label ("  Discount") and are kept on every line it wraps onto.
        const indent = /^ */.exec(left)[0];
        const push = (text) => this.lines.push({ kind: 'text', text, ...style });
        if (value.length > width - 9 - indent.length) {
            // A value that needs most of a line (a long name, say) goes under its label, still at the right edge.
            const label = printable(left);
            if (label)
                wrap(label, width - indent.length).forEach((line) => push(indent + line));
            wrap(value, width).forEach((line) => push(line.padStart(width)));
            return this;
        }
        const labels = wrap(printable(left), Math.max(width - value.length - 1 - indent.length, 8)).map((line) => indent + line);
        labels.slice(0, -1).forEach(push);
        const last = labels.at(-1) ?? '';
        push(last + ' '.repeat(Math.max(width - last.length - value.length, 1)) + value);
        return this;
    }
    /** Cells of fixed width; negative widths are right-aligned. The first cell wraps onto further lines. */
    cells(cells, style = {}) {
        const [first, ...rest] = cells;
        if (!first)
            return this;
        const head = wrap(printable(first[0]), Math.abs(first[1]) - 1);
        const tail = rest
            .map(([text, width]) => {
            const value = printable(text).slice(0, Math.abs(width));
            return width < 0 ? value.padStart(-width) : value.padEnd(width);
        })
            .join('');
        head.forEach((line, index) => this.lines.push({ kind: 'text', text: index === 0 ? line.padEnd(Math.abs(first[1])) + tail : line, ...style }));
        return this;
    }
    rule() {
        this.lines.push({ kind: 'rule' });
        return this;
    }
    feed(lines = 1) {
        this.lines.push({ kind: 'feed', lines });
        return this;
    }
    qr(data) {
        this.lines.push({ kind: 'qr', data });
        return this;
    }
    done(options = {}) {
        return { columns: this.columns, lines: this.lines, copies: options.copies ?? 1, openDrawer: options.openDrawer ?? false };
    }
}
const money = (paise) => formatINR(paise, { symbol: false });
const percent = (bps) => bps / 100 + '%';
const ORDER_TYPES = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };
const METHODS = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };
const dateTime = (iso, timeZone) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
const timeOnly = (iso, timeZone) => new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone }).format(new Date(iso));
/** The restaurant's name as large as fits on one line. */
function title(paper, name) {
    const clean = printable(name);
    paper.text(clean, { align: 'center', bold: true, size: clean.length <= Math.floor(paper.columns / 2) ? 'large' : 'tall' });
}
export function renderReceipt(invoice, layout, columns, timeZone) {
    const paper = new Paper(columns);
    const { seller } = invoice;
    const taxed = invoice.docType === 'TAX_INVOICE';
    const centre = { align: 'center' };
    title(paper, seller.name);
    if (layout.headerNote)
        paper.text(layout.headerNote, centre);
    for (const line of seller.addressLines)
        paper.text(line, centre);
    if (seller.phone)
        paper.text('Ph: ' + seller.phone, centre);
    if (seller.gstin)
        paper.text('GSTIN: ' + seller.gstin, centre);
    if (seller.fssaiNumber)
        paper.text('FSSAI: ' + seller.fssaiNumber, centre);
    paper.text(taxed ? 'TAX INVOICE' : 'BILL OF SUPPLY', { ...centre, bold: true });
    if (invoice.status === 'CANCELLED')
        paper.text('*** CANCELLED ***', { ...centre, bold: true });
    if (invoice.printCount > 0)
        paper.text('(Duplicate copy)', centre);
    paper.rule();
    paper.row('Bill no.', invoice.invoiceNumber);
    paper.row('Date', dateTime(invoice.issuedAt, timeZone));
    paper.row(ORDER_TYPES[invoice.orderType], invoice.tableName ? 'Table ' + invoice.tableName : invoice.tokenNumber ? 'Token ' + invoice.tokenNumber : '');
    paper.row('Cashier', invoice.cashierName);
    if (layout.showCustomer && invoice.customer) {
        // The number identifies the customer, so it is always printed; the name when there is one.
        paper.row('Customer', invoice.customer.name ?? invoice.customer.phone ?? '');
        if (invoice.customer.name && invoice.customer.phone)
            paper.row('Mobile', invoice.customer.phone);
        if (invoice.customer.gstin)
            paper.row('GSTIN', invoice.customer.gstin);
    }
    paper.rule();
    // Wide paper has room for a table; narrow paper puts the name on its own line.
    const table = columns >= 42;
    const nameWidth = columns - 26;
    if (table) {
        paper.cells([['Item', nameWidth], ['Qty', -5], ['Rate', -10], ['Amount', -11]], { bold: true });
        paper.rule();
    }
    for (const item of invoice.items) {
        const name = item.name + (layout.showHsn && item.hsnSac ? ' [' + item.hsnSac + ']' : '');
        if (table)
            paper.cells([[name, nameWidth], [String(item.quantity), -5], [money(item.unitPricePaise), -10], [money(item.grossPaise), -11]]);
        else
            paper.text(name).row('  ' + item.quantity + ' x ' + money(item.unitPricePaise), money(item.grossPaise));
        if (item.discountPaise > 0)
            paper.row('  Discount', '-' + money(item.discountPaise));
    }
    paper.rule();
    paper.row('Subtotal', money(invoice.grossPaise));
    if (invoice.discountPaise > 0)
        paper.row('Discount', '-' + money(invoice.discountPaise));
    if (invoice.serviceChargePaise > 0)
        paper.row('Service charge (optional)', money(invoice.serviceChargePaise));
    if (taxed && invoice.taxes.length > 0) {
        if (layout.showTaxBreakup) {
            paper.row('Taxable value', money(invoice.taxablePaise));
            for (const tax of invoice.taxes)
                paper.row(tax.type + ' ' + percent(tax.rateBps), money(tax.amountPaise));
        }
        else {
            paper.row('GST', money(invoice.taxes.reduce((sum, tax) => sum + tax.amountPaise, 0)));
        }
        if (invoice.taxAddedPaise === 0)
            paper.text('(Prices include GST)');
    }
    if (invoice.roundOffPaise !== 0)
        paper.row('Round off', money(invoice.roundOffPaise));
    paper.rule();
    paper.row('TOTAL', formatINR(invoice.totalPaise), { bold: true, size: 'tall' });
    if (layout.showAmountInWords)
        paper.text(invoice.amountInWords);
    paper.rule();
    for (const payment of invoice.payments.filter((entry) => entry.status === 'SUCCESS')) {
        paper.row('Paid by ' + (METHODS[payment.method] ?? payment.method), money(payment.amountPaise));
        if (payment.changePaise)
            paper.row('  Change returned', money(payment.changePaise));
    }
    for (const refund of invoice.refunds)
        paper.row('Refund ' + refund.creditNoteNumber, '-' + money(refund.amountPaise));
    const due = invoice.totalPaise - invoice.paidPaise;
    if (due > 0 && invoice.status === 'ISSUED') {
        paper.row('Balance due', money(due), { bold: true });
        if (layout.showUpiQr && seller.upiVpa) {
            const link = 'upi://pay?pa=' + encodeURIComponent(seller.upiVpa) + '&pn=' + encodeURIComponent(printable(seller.name)) +
                '&am=' + (due / 100).toFixed(2) + '&cu=INR&tn=' + encodeURIComponent(invoice.invoiceNumber);
            paper.feed().qr(link).text('Scan to pay ' + formatINR(due) + ' by UPI', centre);
        }
    }
    if (seller.footer)
        paper.feed().text(seller.footer, centre);
    const paidInCash = invoice.payments.some((payment) => payment.status === 'SUCCESS' && payment.method === 'CASH');
    // The drawer opens for the bill itself, not for a duplicate printed later.
    return paper.done({ copies: layout.copies, openDrawer: layout.openDrawer && paidInCash && invoice.printCount === 0 });
}
export function renderKot(kot, layout, columns, timeZone) {
    const paper = new Paper(columns);
    const station = (kot.stationName ?? 'Kitchen').toUpperCase();
    const centre = { align: 'center' };
    if (kot.type === 'CANCEL')
        paper.text('*** CANCEL ***', { ...centre, bold: true, size: 'large' }).text(station, { ...centre, bold: true });
    else
        paper.text(station, { ...centre, bold: true, size: printable(station).length <= Math.floor(columns / 2) ? 'large' : 'tall' });
    if (kot.printCount > 0)
        paper.text('(Reprint)', centre);
    paper.rule();
    const where = kot.tableName ? 'Table ' + kot.tableName : kot.orderType === 'DELIVERY' ? 'Delivery' : 'Takeaway';
    // A ticket made offline carries the number printed on it the first time.
    paper.row('KOT ' + (kot.offlineNumber ?? kot.kotNumber), timeOnly(kot.createdAt, timeZone), { bold: true });
    paper.row(where, kot.tokenNumber ? 'Token ' + kot.tokenNumber : '', { bold: true });
    paper.row('Order ' + kot.orderDisplayNumber, layout.showOrderedBy ? kot.createdByName : '');
    paper.rule();
    for (const item of kot.items) {
        paper.text(item.quantity + ' x ' + item.name, { bold: true, ...(layout.largeItems ? { size: 'tall' } : {}) });
        if (item.notes)
            paper.text('   > ' + item.notes);
    }
    if (kot.notes)
        paper.rule().text((kot.type === 'CANCEL' ? 'Reason' : 'Note') + ': ' + kot.notes, { bold: true });
    return paper.done({ copies: layout.copies });
}
export function renderCreditNote(note, columns, timeZone) {
    const paper = new Paper(columns);
    title(paper, note.sellerName);
    if (note.gstin)
        paper.text('GSTIN: ' + note.gstin, { align: 'center' });
    paper.text('CREDIT NOTE', { align: 'center', bold: true }).rule();
    paper.row('Credit note no.', note.creditNoteNumber).row('Date', dateTime(note.createdAt, timeZone)).row('Against bill', note.invoiceNumber);
    if (note.customerName)
        paper.row('Customer', note.customerName);
    paper.row('Issued by', note.createdByName).rule();
    if (note.taxPaise > 0)
        paper.row('Taxable value', money(note.taxablePaise)).row('GST reversed', money(note.taxPaise));
    paper.row('REFUNDED', formatINR(note.amountPaise), { bold: true, size: 'tall' });
    paper.row('Returned by', METHODS[note.method] ?? note.method).rule().text('Reason: ' + note.reason);
    return paper.done();
}
export function renderRegisterReport(register, restaurantName, columns, timeZone) {
    const paper = new Paper(columns);
    title(paper, restaurantName);
    paper.text('CASH REGISTER REPORT', { align: 'center', bold: true }).rule();
    paper.row('Cashier', register.user.name);
    if (register.terminal)
        paper.row('Terminal', register.terminal.code + ' ' + register.terminal.name);
    paper.row('Opened', dateTime(register.openedAt, timeZone));
    if (register.closedAt)
        paper.row('Closed', dateTime(register.closedAt, timeZone));
    if (register.closedByName && register.closedByName !== register.user.name)
        paper.row('Closed by', register.closedByName);
    paper.rule();
    paper.row('Opening cash', money(register.openingCashPaise));
    paper.row('Cash sales', money(register.cashSalesPaise));
    if (register.cashInPaise > 0)
        paper.row('Cash put in', money(register.cashInPaise));
    if (register.cashOutPaise > 0)
        paper.row('Cash taken out', '-' + money(register.cashOutPaise));
    if (register.cashRefundsPaise > 0)
        paper.row('Cash refunds', '-' + money(register.cashRefundsPaise));
    paper.row('Expected in drawer', money(register.expectedCashPaise), { bold: true });
    if (register.countedCashPaise !== null && register.variancePaise !== null) {
        paper.row('Counted', money(register.countedCashPaise), { bold: true });
        const variance = register.variancePaise;
        paper.row(variance === 0 ? 'Difference' : variance < 0 ? 'Short' : 'Over', money(Math.abs(variance)), { bold: true });
    }
    else {
        paper.text('(Register still open)', { align: 'center' });
    }
    if (register.takings.length > 0) {
        paper.rule().text('Takings', { bold: true });
        for (const entry of register.takings) {
            paper.row((METHODS[entry.method] ?? entry.method) + ' (' + entry.count + ')', money(entry.receivedPaise));
            if (entry.refundedPaise > 0)
                paper.row('  Refunded', '-' + money(entry.refundedPaise));
        }
    }
    if (register.movements.length > 0) {
        paper.rule().text('Cash in and out', { bold: true });
        for (const move of register.movements) {
            paper.row((move.type === 'CASH_IN' ? 'In: ' : 'Out: ') + (move.reason ?? ''), (move.type === 'CASH_IN' ? '' : '-') + money(move.amountPaise));
        }
    }
    if (register.denominations) {
        const counted = Object.entries(register.denominations).filter(([, count]) => count > 0).sort((a, b) => Number(b[0]) - Number(a[0]));
        if (counted.length > 0) {
            paper.rule().text('Notes and coins', { bold: true });
            for (const [rupees, count] of counted)
                paper.row('Rs.' + rupees + ' x ' + count, money(Number(rupees) * count * 100));
        }
    }
    if (register.closingNotes)
        paper.rule().text('Notes: ' + register.closingNotes);
    paper.feed(2).text('Signature: ____________________');
    return paper.done();
}
export function renderTestPage(printer, restaurantName, columns, timeZone) {
    const paper = new Paper(columns);
    title(paper, restaurantName);
    paper.text('PRINTER TEST', { align: 'center', bold: true }).rule();
    paper.row('Printer', printer.name).row('Connection', printer.connection.toLowerCase()).row('Paper', printer.paperWidth === 'MM58' ? '58 mm' : '80 mm');
    paper.row('Printed', dateTime(new Date().toISOString(), timeZone)).rule();
    // A ruler: if the last digit wraps onto a second line, the paper width is set wrongly.
    paper.text(Array.from({ length: columns }, (_, index) => String((index + 1) % 10)).join(''));
    paper.text('Bold text', { bold: true }).text('Tall text', { size: 'tall' }).text('Large text', { size: 'large' });
    paper.text('If you can read this, the printer is set up correctly.', { align: 'center' });
    return paper.done();
}
//# sourceMappingURL=layout.js.map