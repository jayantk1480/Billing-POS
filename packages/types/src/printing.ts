/**
 * What the API hands the print bridge. The API lays a printout out as lines of fixed-width text for the
 * printer's paper; the bridge only turns the lines into printer commands. A change to a receipt therefore
 * never needs the bridge at an outlet to be updated.
 */

/** `wide` and `large` characters are twice as wide, so a line holds half as many. */
export type PrintSize = 'normal' | 'wide' | 'tall' | 'large';
export type PrintAlign = 'left' | 'center' | 'right';

export type PrintLine =
  | { kind: 'text'; text: string; align?: PrintAlign; bold?: boolean; size?: PrintSize }
  | { kind: 'rule' }
  | { kind: 'feed'; lines: number }
  | { kind: 'qr'; data: string };

export interface PrintDocument {
  /** Characters per line at normal size: 32 on 58 mm paper, 48 on 80 mm. */
  columns: number;
  lines: PrintLine[];
  copies: number;
  /** Kick the cash drawer wired to the printer before printing. */
  openDrawer: boolean;
}

export const PAPER_COLUMNS = { MM58: 32, MM80: 48 } as const;
export type PaperWidthKey = keyof typeof PAPER_COLUMNS;

/** Where the bridge sends the bytes. */
export interface PrintTarget {
  id: string;
  name: string;
  connection: 'NETWORK' | 'USB' | 'BLUETOOTH';
  host: string | null;
  port: number | null;
  /** A device file (/dev/usb/lp0, /dev/rfcomm0, COM5) or the name of a printer queue on the bridge's computer. */
  devicePath: string | null;
}

/** One job as the bridge receives it. */
export interface BridgeJob {
  id: string;
  title: string;
  attempt: number;
  target: PrintTarget;
  document: PrintDocument;
}
