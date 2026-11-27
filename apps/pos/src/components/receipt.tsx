'use client';

import { formatINR } from '@pos/billing-core';
import { METHOD_LABEL } from '@/lib/api';
import type { InvoiceDto, KotDto } from '@pos/validation';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PaperWidth = 58 | 80;

/** Receipt paper width is a property of the printer at this counter, so it is remembered per device. */
type PrintJob = { invoice: InvoiceDto } | { kots: KotDto[] };

interface Printer {
  width: PaperWidth;
  setWidth: (width: PaperWidth) => void;
  job: PrintJob | null;
  print: (invoice: InvoiceDto) => void;
  /** Prints kitchen tickets, one per page so each can be torn off for its station. */
  printKots: (kots: KotDto[]) => void;
  done: () => void;
}

export const usePrinter = create<Printer>()(
  persist(
    (set) => ({
      width: 80,
      setWidth: (width) => set({ width }),
      job: null,
      print: (invoice) => set({ job: { invoice } }),
      printKots: (kots) => set(kots.length > 0 ? { job: { kots } } : {}),
      done: () => set({ job: null }),
    }),
    { name: 'pos-printer', partialize: (state) => ({ width: state.width }) },
  ),
);

const money = (paise: number) => formatINR(paise, { symbol: false });
const percent = (bps: number) => `${bps / 100}%`;
const TYPES = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: bold ? 700 : 400 }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const rule = { borderTop: '1px dashed #000', margin: '6px 0' } as const;

/** The printed bill, laid out for a 58 mm or 80 mm thermal roll. */
export function Receipt({ invoice, width }: { invoice: InvoiceDto; width: PaperWidth }) {
  const { seller } = invoice;
  const taxed = invoice.docType === 'TAX_INVOICE';
  const issued = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invoice.issuedAt));
  const due = invoice.totalPaise - invoice.paidPaise;
  return (
    <div style={{ width: `${width - 8}mm`, padding: '2mm 4mm 6mm', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: width === 58 ? 10 : 11.5, lineHeight: 1.35, color: '#000' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: width === 58 ? 14 : 16, fontWeight: 700 }}>{seller.name}</div>
        {seller.addressLines.map((line) => <div key={line}>{line}</div>)}
        {seller.phone && <div>Ph: {seller.phone}</div>}
        {seller.gstin && <div>GSTIN: {seller.gstin}</div>}
        {seller.fssaiNumber && <div>FSSAI: {seller.fssaiNumber}</div>}
        <div style={{ marginTop: 4, fontWeight: 700 }}>{taxed ? 'TAX INVOICE' : 'BILL OF SUPPLY'}</div>
        {invoice.status === 'CANCELLED' && <div style={{ fontWeight: 700 }}>*** CANCELLED ***</div>}
        {invoice.printCount > 0 && <div>(Duplicate copy)</div>}
      </div>
      <div style={rule} />
      <Row label="Bill no." value={invoice.invoiceNumber} />
      <Row label="Date" value={issued} />
      <Row label={TYPES[invoice.orderType]} value={invoice.tableName ? `Table ${invoice.tableName}` : invoice.tokenNumber ? `Token ${invoice.tokenNumber}` : ''} />
      <Row label="Cashier" value={invoice.cashierName} />
      {invoice.customer && (
        <>
          <Row label="Customer" value={invoice.customer.name ?? invoice.customer.phone ?? ''} />
          {invoice.customer.name && invoice.customer.phone && <Row label="Mobile" value={invoice.customer.phone} />}
          {invoice.customer.gstin && <Row label="GSTIN" value={invoice.customer.gstin} />}
        </>
      )}
      <div style={rule} />
      {invoice.items.map((item) => (
        <div key={item.id} style={{ marginBottom: 2 }}>
          <div>{item.name}</div>
          <Row label={`  ${item.quantity} × ${money(item.unitPricePaise)}`} value={money(item.grossPaise)} />
          {item.discountPaise > 0 && <Row label="  Discount" value={`-${money(item.discountPaise)}`} />}
        </div>
      ))}
      <div style={rule} />
      <Row label="Subtotal" value={money(invoice.grossPaise)} />
      {invoice.discountPaise > 0 && <Row label="Discount" value={`-${money(invoice.discountPaise)}`} />}
      {invoice.serviceChargePaise > 0 && <Row label="Service charge (optional)" value={money(invoice.serviceChargePaise)} />}
      {taxed && invoice.taxes.length > 0 && (
        <>
          <Row label="Taxable value" value={money(invoice.taxablePaise)} />
          {invoice.taxes.map((tax) => <Row key={`${tax.type}${tax.rateBps}`} label={`${tax.type} ${percent(tax.rateBps)}`} value={money(tax.amountPaise)} />)}
          {invoice.taxAddedPaise === 0 && <div>(Prices include GST)</div>}
        </>
      )}
      {invoice.roundOffPaise !== 0 && <Row label="Round off" value={money(invoice.roundOffPaise)} />}
      <div style={rule} />
      <div style={{ fontSize: width === 58 ? 13 : 15 }}>
        <Row label="TOTAL" value={formatINR(invoice.totalPaise)} bold />
      </div>
      <div style={rule} />
      {invoice.payments.map((payment) => (
        <div key={payment.id}>
          <Row label={`Paid by ${METHOD_LABEL[payment.method] ?? payment.method}`} value={money(payment.amountPaise)} />
          {payment.changePaise ? <Row label="  Change returned" value={money(payment.changePaise)} /> : null}
        </div>
      ))}
      {invoice.refunds.map((refund) => <Row key={refund.id} label={`Refund ${refund.creditNoteNumber}`} value={`-${money(refund.amountPaise)}`} />)}
      {due > 0 && invoice.status === 'ISSUED' && <Row label="Balance due" value={money(due)} bold />}
      {seller.footer && <div style={{ textAlign: 'center', marginTop: 8 }}>{seller.footer}</div>}
    </div>
  );
}

/** A kitchen order ticket: plain, in the same type size as the bill, and only what the station has to make (or stop making). */
export function KotTicket({ kot, width }: { kot: KotDto; width: PaperWidth }) {
  const time = new Intl.DateTimeFormat('en-IN', { timeStyle: 'short' }).format(new Date(kot.createdAt));
  const where = kot.tableName ? 'Table ' + kot.tableName : kot.orderType === 'DELIVERY' ? 'Delivery' : 'Takeaway';
  return (
    <div style={{ width: `${width - 8}mm`, padding: '2mm 4mm 8mm', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: width === 58 ? 10 : 11.5, lineHeight: 1.35, color: '#000', breakAfter: 'page' }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: width === 58 ? 14 : 16 }}>
        {kot.type === 'CANCEL' ? '*** CANCEL ***' : (kot.stationName ?? 'KITCHEN').toUpperCase()}
      </div>
      {kot.type === 'CANCEL' && <div style={{ textAlign: 'center', fontWeight: 700 }}>{(kot.stationName ?? 'Kitchen').toUpperCase()}</div>}
      {kot.printCount > 0 && <div style={{ textAlign: 'center' }}>(Reprint)</div>}
      <div style={rule} />
      <Row label={'KOT ' + (kot.offlineNumber ?? kot.kotNumber)} value={time} bold />
      <Row label={where} value={kot.tokenNumber ? 'Token ' + kot.tokenNumber : ''} bold />
      <Row label={'Order ' + kot.orderDisplayNumber} value={kot.createdByName} />
      <div style={rule} />
      {kot.items.map((item) => (
        <div key={item.id} style={{ marginBottom: 4 }}>
          <div style={{ fontWeight: 700, textDecoration: kot.type === 'CANCEL' ? 'line-through' : undefined }}>
            {item.quantity} × {item.name}
          </div>
          {item.notes && <div style={{ paddingLeft: 12 }}>» {item.notes}</div>}
        </div>
      ))}
      {kot.notes && (
        <>
          <div style={rule} />
          <div style={{ fontWeight: 700 }}>{kot.type === 'CANCEL' ? 'Reason: ' : 'Note: '}{kot.notes}</div>
        </>
      )}
    </div>
  );
}

/**
 * Renders the queued receipt or kitchen tickets into a print-only area and opens the print dialog.
 * On screen the area is hidden; on paper everything else is.
 */
export function PrintArea({ onPrinted, onKotsPrinted }: { onPrinted: (invoice: InvoiceDto) => void; onKotsPrinted: (kots: KotDto[]) => void }) {
  const { job, width, done } = usePrinter();

  useEffect(() => {
    if (!job) return;
    const finish = () => {
      if ('invoice' in job) onPrinted(job.invoice);
      else onKotsPrinted(job.kots);
      done();
    };
    window.addEventListener('afterprint', finish, { once: true });
    // Give the browser one frame to lay out the receipt before the dialog captures it.
    const timer = window.setTimeout(() => window.print(), 80);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', finish);
    };
  }, [job, done, onPrinted, onKotsPrinted]);

  if (!job || typeof document === 'undefined') return null;
  return createPortal(
    <div id="print-area">
      <style>{`@page { size: ${width}mm auto; margin: 0; }`}</style>
      {'invoice' in job ? <Receipt invoice={job.invoice} width={width} /> : job.kots.map((kot) => <KotTicket key={kot.id} kot={kot} width={width} />)}
    </div>,
    document.body,
  );
}
