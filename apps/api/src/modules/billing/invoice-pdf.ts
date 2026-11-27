import { createRequire } from 'node:module';
import { formatINR } from '@pos/billing-core';
import type { InvoiceDto } from '@pos/validation';
import PDFDocument from 'pdfkit';

// DejaVu Sans is bundled because the PDF standard fonts have no rupee sign.
const require = createRequire(import.meta.url);
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const MARGIN = 40;
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#cbd5e1';
const money = (paise: number) => formatINR(paise, { symbol: false });
const percent = (bps: number) => `${bps / 100}%`;
const ORDER_TYPES = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** Renders an A4 tax invoice (or bill of supply) as a PDF. */
export function renderInvoicePdf(invoice: InvoiceDto): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Invoice ${invoice.invoiceNumber}`, Author: invoice.seller.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('regular', FONT).registerFont('bold', FONT_BOLD);

  const width = doc.page.width - MARGIN * 2;
  const right = doc.page.width - MARGIN;
  const taxed = invoice.docType === 'TAX_INVOICE';
  const { seller } = invoice;

  // Seller on the left half, document identity on the right half.
  const sellerWidth = width * 0.5;
  doc.font('bold').fontSize(16).fillColor(INK).text(seller.name, MARGIN, MARGIN, { width: sellerWidth });
  doc.font('regular').fontSize(8.5).fillColor(MUTED);
  if (seller.legalName && seller.legalName !== seller.name) doc.text(seller.legalName, { width: sellerWidth });
  for (const line of seller.addressLines) doc.text(line, { width: sellerWidth });
  for (const line of [seller.gstin && `GSTIN: ${seller.gstin}`, seller.fssaiNumber && `FSSAI: ${seller.fssaiNumber}`, seller.phone && `Phone: ${seller.phone}`]) {
    if (line) doc.text(line, { width: sellerWidth });
  }
  const leftBottom = doc.y;

  doc.font('bold').fontSize(13).fillColor(INK).text(taxed ? 'TAX INVOICE' : 'BILL OF SUPPLY', MARGIN, MARGIN, { width, align: 'right' });
  doc.font('regular').fontSize(8.5).fillColor(MUTED);
  const issued = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(invoice.issuedAt));
  const facts = [
    ['Invoice no.', invoice.invoiceNumber],
    ['Date', issued],
    ['Order', `${invoice.orderDisplayNumber} · ${ORDER_TYPES[invoice.orderType]}${invoice.tableName ? ` · Table ${invoice.tableName}` : ''}`],
    ['Place of supply', `${invoice.placeOfSupplyName} (${invoice.placeOfSupply})`],
  ];
  // Two right-hand columns: labels end where the values begin, so they can never overlap.
  const valueWidth = 150;
  let factY = doc.y + 2;
  for (const [label, value] of facts) {
    doc.fillColor(MUTED).text(`${label}:`, right - valueWidth - 86, factY, { width: 80, align: 'right' });
    doc.fillColor(INK).text(value!, right - valueWidth, factY, { width: valueWidth, align: 'right' });
    factY = doc.y + 1;
  }
  let y = Math.max(leftBottom, doc.y) + 12;

  if (invoice.status === 'CANCELLED') {
    doc.font('bold').fontSize(10).fillColor('#dc2626').text(`CANCELLED${invoice.cancelReason ? `: ${invoice.cancelReason}` : ''}`, MARGIN, y, { width });
    y = doc.y + 8;
  }

  if (invoice.customer) {
    doc.font('bold').fontSize(8.5).fillColor(MUTED).text('BILLED TO', MARGIN, y);
    doc.font('regular').fontSize(9.5).fillColor(INK).text(invoice.customer.name ?? invoice.customer.phone ?? '');
    doc.fontSize(8.5).fillColor(MUTED);
    for (const line of [invoice.customer.name && invoice.customer.phone, invoice.customer.gstin && `GSTIN: ${invoice.customer.gstin}`, invoice.customer.address]) {
      if (line) doc.text(line, { width: width * 0.6 });
    }
    y = doc.y + 10;
  }

  // Item table. Column widths add up to the page width.
  const columns = taxed
    ? [{ key: 'n', label: '#', w: 20, align: 'left' }, { key: 'name', label: 'Item', w: 165, align: 'left' }, { key: 'hsn', label: 'HSN/SAC', w: 50, align: 'left' },
       { key: 'qty', label: 'Qty', w: 28, align: 'right' }, { key: 'rate', label: 'Rate', w: 55, align: 'right' }, { key: 'disc', label: 'Discount', w: 50, align: 'right' },
       { key: 'taxable', label: 'Taxable', w: 57, align: 'right' }, { key: 'gst', label: 'GST', w: 30, align: 'right' }, { key: 'amount', label: 'Amount', w: 60, align: 'right' }]
    : [{ key: 'n', label: '#', w: 20, align: 'left' }, { key: 'name', label: 'Item', w: 275, align: 'left' }, { key: 'qty', label: 'Qty', w: 40, align: 'right' },
       { key: 'rate', label: 'Rate', w: 60, align: 'right' }, { key: 'disc', label: 'Discount', w: 60, align: 'right' }, { key: 'amount', label: 'Amount', w: 60, align: 'right' }];
  const row = (cells: Record<string, string>, top: number, bold = false): number => {
    doc.font(bold ? 'bold' : 'regular').fontSize(8.5).fillColor(bold ? MUTED : INK);
    let x = MARGIN;
    let bottom = top;
    for (const column of columns) {
      doc.text(cells[column.key] ?? '', x + 2, top, { width: column.w - 4, align: column.align as 'left' | 'right' });
      bottom = Math.max(bottom, doc.y);
      x += column.w;
    }
    return bottom;
  };
  const rule = (at: number, colour = LINE) => doc.moveTo(MARGIN, at).lineTo(right, at).lineWidth(0.6).strokeColor(colour).stroke();

  rule(y);
  y = row(Object.fromEntries(columns.map((c) => [c.key, c.label])), y + 5, true) + 4;
  rule(y);
  y += 5;
  for (const [index, item] of invoice.items.entries()) {
    if (y > doc.page.height - 220) {
      doc.addPage();
      y = MARGIN;
    }
    y = row({
      n: String(index + 1), name: item.name, hsn: item.hsnSac ?? '', qty: String(item.quantity), rate: money(item.unitPricePaise),
      disc: item.discountPaise ? money(item.discountPaise) : '', taxable: money(item.taxablePaise), gst: item.taxRateBps ? percent(item.taxRateBps) : '',
      amount: money(taxed ? item.totalPaise : item.grossPaise - item.discountPaise),
    }, y) + 4;
  }
  rule(y);
  y += 10;

  // Totals, right-aligned under the table.
  const labelX = right - 230;
  const total = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'bold' : 'regular').fontSize(bold ? 11 : 9).fillColor(bold ? INK : MUTED).text(label, labelX, y, { width: 140 });
    doc.fillColor(INK).text(value, right - 90, y, { width: 90, align: 'right' });
    y = doc.y + (bold ? 4 : 3);
  };
  total('Subtotal', money(invoice.grossPaise));
  if (invoice.discountPaise) total('Discount', `− ${money(invoice.discountPaise)}`);
  if (invoice.serviceChargePaise) total('Service charge (optional)', money(invoice.serviceChargePaise));
  if (taxed) {
    total('Taxable value', money(invoice.taxablePaise));
    for (const tax of invoice.taxes) total(`${tax.type} ${percent(tax.rateBps)}`, money(tax.amountPaise));
    if (invoice.taxAddedPaise === 0 && invoice.taxes.length > 0) {
      doc.font('regular').fontSize(7.5).fillColor(MUTED).text('Prices include GST', labelX, y, { width: 230 });
      y = doc.y + 3;
    }
  }
  if (invoice.roundOffPaise) total('Round off', `${invoice.roundOffPaise > 0 ? '+' : '−'} ${money(Math.abs(invoice.roundOffPaise))}`);
  doc.moveTo(labelX, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
  y += 6;
  total('Total (₹)', formatINR(invoice.totalPaise), true);

  doc.font('regular').fontSize(8.5).fillColor(MUTED).text(invoice.amountInWords, MARGIN, y + 4, { width });
  y = doc.y + 10;

  if (invoice.payments.length || invoice.refunds.length) {
    doc.font('bold').fontSize(8.5).fillColor(MUTED).text('PAYMENTS', MARGIN, y);
    doc.font('regular').fontSize(8.5).fillColor(INK);
    for (const payment of invoice.payments) {
      doc.text(`${payment.method}  ${formatINR(payment.amountPaise)}${payment.reference ? `  (ref. ${payment.reference})` : ''}`);
    }
    for (const refund of invoice.refunds) {
      doc.text(`Refund ${refund.creditNoteNumber}  − ${formatINR(refund.amountPaise)}  (${refund.method})`);
    }
    y = doc.y + 10;
  }

  doc.font('regular').fontSize(8).fillColor(MUTED);
  if (seller.footer) doc.text(seller.footer, MARGIN, y, { width, align: 'center' });
  doc.text('This is a computer-generated invoice.', MARGIN, doc.page.height - MARGIN - 12, { width, align: 'center', lineBreak: false });

  doc.end();
  return done;
}
