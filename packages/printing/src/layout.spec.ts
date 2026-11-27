import type { PrintDocument } from '@pos/types';
import type { InvoiceDto, KotDto } from '@pos/validation';
import { kotLayoutSchema, receiptLayoutSchema } from '@pos/validation';
import { Paper, printable, renderKot, renderReceipt, wrap } from './layout.js';

const textOf = (document: PrintDocument) => document.lines.flatMap((line) => (line.kind === 'text' ? [line.text] : []));

function fits(document: PrintDocument): void {
  for (const line of document.lines) {
    if (line.kind !== 'text') continue;
    const room = line.size === 'wide' || line.size === 'large' ? Math.floor(document.columns / 2) : document.columns;
    expect(line.text.length, line.text).toBeLessThanOrEqual(room);
    expect(line.text).toMatch(/^[\x20-\x7e]*$/);
  }
}

const invoice = {
  id: 'i1', invoiceNumber: 'A1/2627/000123', status: 'ISSUED', paymentStatus: 'PARTIALLY_PAID', totalPaise: 123_456_700, paidPaise: 100_000, refundedPaise: 0,
  orderId: 'o1', orderDisplayNumber: 'A1-12', orderType: 'DINE_IN', tableName: 'Garden 12', tokenNumber: null, docType: 'TAX_INVOICE', businessDate: '2026-11-22',
  issuedAt: '2026-11-22T13:45:00.000Z',
  seller: {
    name: 'Śrī Annapūrṇā Bhojanālaya & Family Restaurant', legalName: null, gstin: '27AAAAA0000A1Z5', fssaiNumber: '12345678901234', phone: '+91 98765 43210',
    addressLines: ['Shop 4, Ground Floor, Mahatma Gandhi Road Opposite The Old Clock Tower', 'Pune, Maharashtra, 411001'], stateCode: '27', stateName: 'Maharashtra',
    footer: 'Thank you — visit again! धन्यवाद', upiVpa: 'annapurna@okbank',
  },
  customer: { id: 'c1', name: 'Rajeshwari Venkatasubramanian-Krishnamoorthy', phone: '9876543210', gstin: '27BBBBB1111B1Z6', address: null },
  placeOfSupply: '27', placeOfSupplyName: 'Maharashtra', isInterState: false, grossPaise: 117_577_800, discountPaise: 0, taxablePaise: 117_577_800,
  cgstPaise: 2_939_445, sgstPaise: 2_939_445, igstPaise: 0, cessPaise: 0, taxAddedPaise: 5_878_890, serviceChargePaise: 0, roundOffPaise: 10,
  amountInWords: 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Only', printCount: 0, cashierName: 'Bhuvaneshwari', cancelReason: null,
  items: [
    { id: 'a', name: 'Paneer Tikka Masala with Extra Butter Naan and a Very Long Description', hsnSac: '996331', quantity: 120, unitPricePaise: 979_815, grossPaise: 117_577_800, discountPaise: 500, taxablePaise: 117_577_300, taxRateBps: 500, cgstPaise: 1, sgstPaise: 1, igstPaise: 0, cessPaise: 0, totalPaise: 1, refundedQuantity: 0 },
    { id: 'b', name: 'Supercalifragilisticexpialidocious-Special-Thali', hsnSac: null, quantity: 1, unitPricePaise: 100, grossPaise: 100, discountPaise: 0, taxablePaise: 100, taxRateBps: 500, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0, totalPaise: 100, refundedQuantity: 0 },
  ],
  taxes: [{ type: 'CGST', rateBps: 250, taxablePaise: 117_577_800, amountPaise: 2_939_445 }, { type: 'SGST', rateBps: 250, taxablePaise: 117_577_800, amountPaise: 2_939_445 }],
  payments: [{ id: 'p', method: 'CASH', status: 'SUCCESS', amountPaise: 100_000, tenderedPaise: 200_000, changePaise: 100_000, refundedPaise: 0, reference: null, receivedByName: 'B', paidAt: null }],
  refunds: [],
} as unknown as InvoiceDto;

const kot = {
  id: 'k1', kotNumber: 42, offlineNumber: null, type: 'NEW', status: 'PENDING', stationId: 's1', stationName: 'Tandoor and Curry Section', orderId: 'o1', orderDisplayNumber: 'A1-12',
  orderType: 'DINE_IN', tableName: 'Garden 12', tokenNumber: 7, notes: 'Guest is allergic to peanuts — tell the chef', printCount: 0, createdByName: 'Bhuvaneshwari',
  createdAt: '2026-11-22T13:45:00.000Z', preparingAt: null, readyAt: null, completedAt: null,
  items: [{ id: 'x', name: 'Paneer Tikka Masala with Extra Butter Naan (Full)', quantity: 12, cancelledQuantity: 0, notes: 'No onion · extra spicy' }],
} as unknown as KotDto;

describe('print layout', () => {
  it('replaces what a thermal printer cannot show', () => {
    expect(printable('Total ₹1,234.50')).toBe('Total Rs.1,234.50');
    expect(printable('Café “Śrī” — 2 × chai…')).toBe('Cafe "Sri" - 2 x chai...');
    expect(printable('10:15 pm')).toBe('10:15 pm');
    expect(printable('धन्यवाद')).toMatch(/^\?+$/);
  });

  it('wraps at spaces and breaks a word that is longer than the line', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('abcdefghijkl mn', 5)).toEqual(['abcde', 'fghij', 'kl mn']);
    expect(wrap('', 10)).toEqual(['']);
  });

  it('keeps a value at the right edge, wrapping a long label above it', () => {
    const paper = new Paper(20).row('Subtotal', '570.00').row('  Service charge (optional)', '57.00').row('TOTAL', 'Rs.1.00', { size: 'large' });
    // At double width a 20-column line holds 10 characters, so the amount goes under its label.
    expect(textOf(paper.done())).toEqual(['Subtotal      570.00', '  Service', '  charge', '  (optional)   57.00', 'TOTAL', '   Rs.1.00']);
    expect(textOf(new Paper(20).row('Customer', 'Rajeshwari Venkatasubramanian').done())).toEqual(['Customer', '          Rajeshwari', '  Venkatasubramanian']);
  });

  it.each([[32], [48]])('fits a bill with long names and large amounts on %i-column paper', (columns) => {
    const layout = receiptLayoutSchema.parse({ showHsn: true, showAmountInWords: true, headerNote: 'Pure vegetarian since 1998, now open on all seven days of the week' });
    const document = renderReceipt(invoice, layout, columns, 'Asia/Kolkata');
    fits(document);
    const text = textOf(document).join('\n');
    expect(text).toContain('A1/2627/000123');
    // India time, whatever time zone the server runs in.
    expect(text).toMatch(/22 Nov 2026, 7:15 pm/);
    expect(text).toMatch(/Balance due\s+12,33,567\.00/);
    expect(document.lines.some((line) => line.kind === 'qr')).toBe(true);
    expect(document.openDrawer).toBe(true);
  });

  it.each([[32], [48]])('fits a kitchen ticket on %i-column paper, in the bill\'s type sizes unless larger items are asked for', (columns) => {
    const document = renderKot(kot, kotLayoutSchema.parse({}), columns, 'Asia/Kolkata');
    fits(document);
    const itemLine = (printed: typeof document) => printed.lines.find((line) => line.kind === 'text' && line.text.startsWith('12 x Paneer'));
    // Bold, at the ordinary size: only the station name is set large, as the restaurant's name is on a bill.
    expect(itemLine(document)).toMatchObject({ bold: true });
    expect(itemLine(document)).not.toHaveProperty('size');
    expect(document.lines.filter((line) => line.kind === 'text' && line.size && line.size !== 'normal')).toHaveLength(1);
    expect(itemLine(renderKot(kot, kotLayoutSchema.parse({ largeItems: true }), columns, 'Asia/Kolkata'))).toMatchObject({ bold: true, size: 'tall' });
    expect(textOf(document).join(' ')).toContain('Note: Guest is allergic to peanuts - tell the chef');
    const cancelled = renderKot({ ...kot, type: 'CANCEL', printCount: 1 }, kotLayoutSchema.parse({}), columns, 'Asia/Kolkata');
    fits(cancelled);
    expect(textOf(cancelled).slice(0, 3)).toEqual(['*** CANCEL ***', 'TANDOOR AND CURRY SECTION', '(Reprint)']);
    expect(textOf(cancelled).join(' ')).toContain('Reason: Guest is allergic');
  });
});
