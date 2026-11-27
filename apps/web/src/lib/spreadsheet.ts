import { BULK_PRODUCT_LIMIT, type BulkProductRow } from '@pos/validation';

/**
 * Splits a CSV file, or rows pasted from Excel or Google Sheets (which arrive tab-separated), into cells.
 * Cells may be quoted, with "" for a quote and line breaks inside the quotes. Blank rows are dropped; each row keeps
 * its row number in the sheet, counted from 1, so a mistake can be pointed at.
 */
export function parseTable(text: string): { line: number; cells: string[] }[] {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      rows.push([...row, cell]);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows.map((cells, index) => ({ line: index + 1, cells: cells.map((c) => c.trim()) })).filter((r) => r.cells.some((c) => c !== ''));
}

const quote = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
export const toCsv = (rows: string[][]) => rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';

/** Headings a column may carry, compared without capitals, spaces or punctuation: "Short Code" and "short_code" are the same. */
const HEADINGS: Record<keyof BulkProductRow, string[]> = {
  name: ['name', 'product', 'productname', 'item', 'itemname', 'dish'],
  category: ['category', 'categoryname'],
  price: ['price', 'rate', 'mrp', 'amount', 'sellingprice', 'pricers', 'priceinr'],
  shortCode: ['shortcode', 'code'],
  foodType: ['type', 'foodtype', 'vegnonveg', 'vegornonveg'],
  taxGroup: ['taxgroup', 'tax', 'gst'],
  description: ['description', 'details'],
  hsnSac: ['hsnsac', 'hsn', 'sac', 'hsncode', 'saccode'],
};
export const PRODUCT_COLUMNS = ['Name', 'Category', 'Price', 'Short code', 'Type', 'Tax group', 'Description', 'HSN/SAC'];

export interface SheetProduct {
  /** Row number in the sheet, counted from 1 with the headings as row 1. */
  line: number;
  row: BulkProductRow;
}

/** Reads products from a sheet whose first row names the columns. Returns the rows, or why the sheet cannot be used. */
export function readProductSheet(text: string): { products: SheetProduct[] } | { error: string } {
  const [header, ...body] = parseTable(text);
  if (!header) return { error: 'There is nothing to add yet. Choose a file or paste some rows.' };

  const column = {} as Record<keyof BulkProductRow, number>;
  for (const field of Object.keys(HEADINGS) as (keyof BulkProductRow)[]) {
    column[field] = header.cells.findIndex((heading) => HEADINGS[field].includes(heading.toLowerCase().replace(/[^a-z]/g, '')));
  }
  const missing = ([['name', 'Name'], ['category', 'Category'], ['price', 'Price']] as const).filter(([field]) => column[field] < 0).map(([, heading]) => heading);
  if (missing.length > 0) {
    return { error: `The first row must name the columns. ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing. Download the template to see the layout.` };
  }
  if (body.length === 0) return { error: 'The sheet has column headings but no products under them.' };
  if (body.length > BULK_PRODUCT_LIMIT) {
    return { error: `This sheet has ${body.length} products. Add at most ${BULK_PRODUCT_LIMIT} at a time: split it and add it in parts.` };
  }

  const products = body.map(({ line, cells }) => {
    const row = {} as Record<keyof BulkProductRow, string>;
    for (const field of Object.keys(HEADINGS) as (keyof BulkProductRow)[]) row[field] = (column[field] >= 0 ? cells[column[field]] : '') ?? '';
    return { line, row };
  });
  return { products };
}

/** A starter sheet: the column headings and two example rows that use this restaurant's own category and tax group names. */
export function productTemplate(categoryName: string, taxGroupName: string): string {
  return toCsv([
    PRODUCT_COLUMNS,
    ['Paneer Tikka', categoryName, '260', 'PT', 'veg', taxGroupName, 'Cottage cheese grilled in the tandoor', '996331'],
    ['Chicken Tikka', categoryName, '320', 'CT', 'non-veg', '', '', ''],
  ]);
}
