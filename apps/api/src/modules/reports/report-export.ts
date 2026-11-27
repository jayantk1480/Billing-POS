import { createRequire } from 'node:module';
import type { ReportCell, ReportColumn, ReportData } from '@pos/validation';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const NUMERIC = new Set<ReportColumn['type']>(['number', 'money', 'percent']);
const rupees = (paise: number) => paise / 100;
const dateTime = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
const period = (report: ReportData) => (report.from === report.to ? report.from : report.from + ' to ' + report.to);

/** A cell as text for CSV and PDF. Money is in rupees with two decimals and no symbol, so it stays a number in a spreadsheet. */
function text(value: ReportCell, type: ReportColumn['type'], grouped = false): string {
  if (value === null || value === '') return '';
  if (type === 'money') {
    return grouped ? rupees(Number(value)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : rupees(Number(value)).toFixed(2);
  }
  if (type === 'percent') return value + '%';
  if (type === 'datetime') return dateTime(String(value));
  return String(value);
}

/** The totals line: "Total" under the first column, sums under the columns that have one. */
function totalCells<T>(report: ReportData, render: (value: number, column: ReportColumn) => T, label: T, blank: T): T[] {
  return report.columns.map((column, index) => (index === 0 ? label : column.key in report.totals! ? render(report.totals![column.key]!, column) : blank));
}

export function toCsv(report: ReportData): Buffer {
  const escape = (cell: string) => {
    // A leading quote stops a spreadsheet treating text such as "=1+1" in a customer name as a formula.
    const safe = /^[=+\-@\t\r]/.test(cell) && Number.isNaN(Number(cell)) ? "'" + cell : cell;
    return /[",\n\r]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
  };
  const lines = [
    report.columns.map((column) => escape(column.label)).join(','),
    ...report.rows.map((row) => report.columns.map((column) => escape(text(row[column.key] ?? null, column.type))).join(',')),
  ];
  if (report.totals) lines.push(totalCells(report, (value, column) => text(value, column.type), 'Total', '').join(','));
  // The byte-order mark makes Excel read the rupee sign and Indian names correctly.
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

export async function toXlsx(report: ReportData, restaurantName: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(report.generatedAt);
  const sheet = workbook.addWorksheet(report.title.slice(0, 31).replace(/[\\/*?:[\]]/g, ' '));
  sheet.addRow([restaurantName]).font = { bold: true, size: 14 };
  sheet.addRow([report.title + ': ' + period(report)]).font = { bold: true };
  if (report.note) sheet.addRow([report.note]).font = { italic: true, color: { argb: 'FF64748B' } };
  for (const figure of report.summary) {
    const row = sheet.addRow([figure.label, figure.type === 'money' ? rupees(figure.value) : figure.value]);
    row.getCell(2).font = { bold: true };
    row.getCell(2).alignment = { horizontal: 'left' };
    if (figure.type === 'money') row.getCell(2).numFmt = '#,##0.00';
  }
  sheet.addRow([]);

  const header = sheet.addRow(report.columns.map((column) => column.label));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  });
  sheet.views = [{ state: 'frozen', ySplit: header.number }];

  // Numbers are stored as numbers so they can be summed; everything else is stored as plain text, never as a formula.
  const value = (cell: ReportCell, type: ReportColumn['type']): string | number | null => {
    if (cell === null || cell === '') return null;
    if (type === 'money') return rupees(Number(cell));
    if (type === 'percent') return Number(cell) / 100;
    if (type === 'number') return Number(cell);
    if (type === 'datetime') return dateTime(String(cell));
    return String(cell);
  };
  for (const row of report.rows) sheet.addRow(report.columns.map((column) => value(row[column.key] ?? null, column.type)));
  if (report.totals) {
    const total = sheet.addRow(totalCells<string | number | null>(report, (sum, column) => value(sum, column.type), 'Total', null));
    total.font = { bold: true };
    total.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FF64748B' } } };
    });
  }

  report.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    const longest = Math.max(column.label.length, ...report.rows.slice(0, 500).map((row) => text(row[column.key] ?? null, column.type, true).length));
    sheetColumn.width = Math.min(Math.max(longest + 3, 10), 48);
    if (column.type === 'money') sheetColumn.numFmt = '#,##0.00';
    if (column.type === 'percent') sheetColumn.numFmt = '0.##%';
    if (NUMERIC.has(column.type)) sheetColumn.alignment = { horizontal: 'right' };
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function toPdf(report: ReportData, restaurantName: string): Promise<Buffer> {
  const margin = 32;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin, info: { Title: report.title + ' ' + period(report), Author: restaurantName }, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('regular', FONT).registerFont('bold', FONT_BOLD);
  const width = doc.page.width - margin * 2;
  const bottom = doc.page.height - margin - 16;

  doc.font('bold').fontSize(13).fillColor('#0f172a').text(restaurantName, margin, margin);
  doc.font('regular').fontSize(10).text(report.title + ' · ' + period(report));
  if (report.note) doc.fontSize(7.5).fillColor('#64748b').text(report.note, { width });
  if (report.summary.length > 0) {
    const figures = report.summary.map((figure) => figure.label + ': ' + (figure.type === 'money' ? '₹' + text(figure.value, 'money', true) : String(figure.value)));
    doc.moveDown(0.5).font('bold').fontSize(9).fillColor('#0f172a').text(figures.join('     '), { width });
  }
  let y = doc.y + 10;

  const size = report.columns.length > 14 ? 5.5 : report.columns.length > 9 ? 6.5 : 7.5;
  const headerCells = report.columns.map((column) => column.label);
  const totalRow = report.totals ? totalCells(report, (value, column) => text(value, column.type, true), 'Total', '') : null;

  // Each column is as wide as its widest value. Number columns always get that much, so a figure never
  // breaks across lines; text columns share whatever is left, and wrap if there is not enough.
  doc.font('bold').fontSize(size);
  const sample = report.rows.slice(0, 400);
  const natural = report.columns.map((column, index) => {
    const cells = [...headerCells[index]!.split(' '), ...sample.map((row) => text(row[column.key] ?? null, column.type, true)), totalRow?.[index] ?? ''];
    const widest = Math.max(...cells.map((cell) => doc.widthOfString(cell)));
    return Math.min(widest + 10, NUMERIC.has(column.type) ? 200 : 190);
  });
  const isNumber = report.columns.map((column) => NUMERIC.has(column.type));
  const fixed = natural.reduce((sum, value, index) => sum + (isNumber[index] ? value : 0), 0);
  const flexible = natural.reduce((sum, value, index) => sum + (isNumber[index] ? 0 : value), 0);
  let widths: number[];
  if (flexible === 0) {
    widths = natural.map((value) => (value * width) / fixed);
  } else {
    const share = Math.max(width - fixed, width * 0.25) / flexible;
    widths = natural.map((value, index) => (isNumber[index] ? value : Math.max(value * share, 28)));
    // If even that is too much (very many number columns), scale everything to the page.
    const total = widths.reduce((a, b) => a + b, 0);
    if (total > width) widths = widths.map((value) => (value * width) / total);
  }

  const draw = (cells: string[], bold: boolean): void => {
    doc.font(bold ? 'bold' : 'regular').fontSize(size);
    const height = Math.max(...cells.map((cell, index) => doc.heightOfString(cell, { width: widths[index]! - 6 }))) + 5;
    if (y + height > bottom) {
      doc.addPage();
      y = margin;
      // Repeat the column headings at the top of every page.
      if (cells !== headerCells) draw(headerCells, true);
      doc.font(bold ? 'bold' : 'regular').fontSize(size);
    }
    let x = margin;
    cells.forEach((cell, index) => {
      doc.fillColor('#0f172a').text(cell, x + 3, y + 2.5, { width: widths[index]! - 6, align: NUMERIC.has(report.columns[index]!.type) ? 'right' : 'left' });
      x += widths[index]!;
    });
    y += height;
    doc.moveTo(margin, y).lineTo(margin + width, y).lineWidth(0.4).strokeColor(bold ? '#64748b' : '#e2e8f0').stroke();
  };

  draw(headerCells, true);
  for (const row of report.rows) draw(report.columns.map((column) => text(row[column.key] ?? null, column.type, true)), false);
  if (totalRow) draw(totalRow, true);
  if (report.rows.length === 0) doc.font('regular').fontSize(9).fillColor('#64748b').text('Nothing to report for this period.', margin, y + 12);

  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    doc.switchToPage(index);
    // The footer sits inside the bottom margin; without lifting the margin PDFKit would start a new page for it.
    doc.page.margins.bottom = 0;
    doc.font('regular').fontSize(7).fillColor('#64748b').text(
      'Generated ' + dateTime(report.generatedAt) + ' · Amounts in ₹ · Page ' + (index + 1) + ' of ' + pages.count,
      margin, doc.page.height - 24, { width, align: 'right', lineBreak: false },
    );
  }
  doc.end();
  return done;
}
