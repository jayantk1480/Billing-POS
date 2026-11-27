import type { PrintAlign, PrintDocument, PrintSize } from '@pos/types';

/**
 * Turns a printout into ESC/POS, the command language nearly every thermal receipt printer speaks.
 * Only the common core is used (text, alignment, bold, double size, QR code, cut, drawer kick), so the
 * same bytes work on 58 mm and 80 mm printers from different makers.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const ALIGN: Record<PrintAlign, number> = { left: 0, center: 1, right: 2 };
/** GS ! n: the high nibble doubles the width, the low nibble the height. */
const SIZE: Record<PrintSize, number> = { normal: 0x00, wide: 0x10, tall: 0x01, large: 0x11 };

/** The API sends plain ASCII; anything else is replaced rather than sent to a printer that would garble it. */
const ascii = (text: string) => Buffer.from(text.replace(/[^\x20-\x7e]/g, '?'), 'ascii');

function qrCode(data: string): Buffer[] {
  const payload = Buffer.from(data, 'utf8');
  const length = payload.length + 3;
  return [
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // model 2
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06]), // module size: 6 dots
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]), // error correction: M
    Buffer.from([GS, 0x28, 0x6b, length & 0xff, length >> 8, 0x31, 0x50, 0x30]), // store the data
    payload,
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), // print it
  ];
}

function onePrintout(document: PrintDocument, openDrawer: boolean): Buffer[] {
  const out: Buffer[] = [Buffer.from([ESC, 0x40])]; // reset the printer
  // Pin 2 of the drawer socket, pulse 50 ms on and 500 ms off: the usual wiring.
  if (openDrawer) out.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
  const style = (align: PrintAlign, bold: boolean, size: PrintSize) =>
    out.push(Buffer.from([ESC, 0x61, ALIGN[align], ESC, 0x45, bold ? 1 : 0, GS, 0x21, SIZE[size]]));

  for (const line of document.lines) {
    if (line.kind === 'text') {
      style(line.align ?? 'left', line.bold ?? false, line.size ?? 'normal');
      out.push(ascii(line.text), Buffer.from([LF]));
    } else if (line.kind === 'rule') {
      style('left', false, 'normal');
      out.push(ascii('-'.repeat(document.columns)), Buffer.from([LF]));
    } else if (line.kind === 'feed') {
      out.push(Buffer.from([ESC, 0x64, Math.min(Math.max(line.lines, 1), 10)]));
    } else {
      style('center', false, 'normal');
      out.push(...qrCode(line.data), Buffer.from([LF]));
    }
  }
  style('left', false, 'normal');
  // Feed past the cutter, then cut, leaving a small bridge so the slip does not fall.
  out.push(Buffer.from([ESC, 0x64, 4, GS, 0x56, 0x42, 0x00]));
  return out;
}

/** The bytes to send to the printer, with every copy asked for. The drawer opens once, with the first copy. */
export function encode(document: PrintDocument): Buffer {
  const copies = Math.min(Math.max(document.copies, 1), 5);
  const parts: Buffer[] = [];
  for (let copy = 0; copy < copies; copy += 1) parts.push(...onePrintout(document, document.openDrawer && copy === 0));
  return Buffer.concat(parts);
}
