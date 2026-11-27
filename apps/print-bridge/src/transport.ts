import { execFile } from 'node:child_process';
import { open, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrintTarget } from '@pos/types';

/** How long a printer gets to accept a printout before it counts as not answering. */
export const PRINT_TIMEOUT_MS = 8_000;

/**
 * Where this bridge is willing to send bytes. Printer settings come from the server, and a stolen back-office
 * login must not be able to turn the bridge into a way of writing to files or talking to other services on the
 * outlet's network. So by default it only prints to the ports and devices printers actually use; the person who
 * installs the bridge can allow more, on the bridge computer itself.
 */
export interface SendLimits {
  /** Network ports allowed besides 9100 to 9109. */
  extraPorts?: number[];
  /** Device paths allowed besides the usual printer devices. */
  extraDevices?: string[];
  /** For tests, which listen on whatever port is free. */
  anyPort?: boolean;
  timeoutMs?: number;
}

const PRINTER_PORTS = { from: 9100, to: 9109 };
const PRINTER_DEVICES = [
  /^\/dev\/usb\/lp\d+$/, /^\/dev\/lp\d+$/, // USB and parallel printers on Linux
  /^\/dev\/rfcomm\d+$/, /^\/dev\/tty(USB|ACM|S)\d+$/, // Bluetooth and serial on Linux
  /^\/dev\/(cu|tty)\.[\w.-]+$/, // serial and Bluetooth on macOS
  /^COM\d+$/i, // serial and Bluetooth on Windows
];

/** A failure the cashier can act on, sent back to the API and shown at the counter. */
export class PrintError extends Error {}

const NETWORK_ERRORS: Record<string, string> = {
  ECONNREFUSED: 'The printer refused the connection. Check that it is switched on.',
  ETIMEDOUT: 'The printer did not answer. Check that it is switched on and connected.',
  EHOSTUNREACH: 'The printer could not be reached on the network. Check its cable or Wi-Fi.',
  ENETUNREACH: 'The printer could not be reached on the network. Check its cable or Wi-Fi.',
  EHOSTDOWN: 'The printer could not be reached on the network. Check its cable or Wi-Fi.',
  ENOTFOUND: 'The printer address was not found. Check the address in the printer settings.',
  ECONNRESET: 'The printer dropped the connection while printing.',
  EPIPE: 'The printer dropped the connection while printing.',
};
const DEVICE_ERRORS: Record<string, string> = {
  ENOENT: 'The printer was not found on this computer. Check that it is plugged in or paired.',
  EACCES: 'This computer does not allow the print bridge to use that printer.',
  EPERM: 'This computer does not allow the print bridge to use that printer.',
  EBUSY: 'The printer is busy with something else.',
};
const codeOf = (error: unknown) => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '');

/** Raw printing over the network: the printer listens on a port (9100 unless set otherwise) and prints what it is sent. */
function sendToNetwork(host: string, port: number, data: Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (error?: PrintError) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new PrintError(NETWORK_ERRORS.ETIMEDOUT)));
    socket.once('error', (error) => finish(new PrintError(NETWORK_ERRORS[codeOf(error)] ?? 'The printer could not be reached: ' + error.message)));
    // Ending the connection after the data lets the printer finish reading; a clean close means it took everything.
    socket.once('connect', () => socket.end(data));
    socket.once('close', () => finish());
  });
}

/** A device file or serial port: a USB printer (/dev/usb/lp0), a paired Bluetooth printer (/dev/rfcomm0, COM5). */
async function sendToDevice(devicePath: string, data: Buffer, timeoutMs: number): Promise<void> {
  const target = /^COM\d+$/i.test(devicePath) ? '\\\\.\\' + devicePath.toUpperCase() : devicePath;
  let timer: NodeJS.Timeout | undefined;
  const write = (async () => {
    const handle = await open(target, 'w');
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PrintError('The printer did not take the printout. Check that it is switched on.')), timeoutMs);
  });
  try {
    await Promise.race([write, timeout]);
  } catch (error) {
    if (error instanceof PrintError) throw error;
    throw new PrintError(DEVICE_ERRORS[codeOf(error)] ?? 'The printer could not be used: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}

const run = (command: string, args: string[], timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr || error.message).trim().split('\n')[0] ?? '';
      reject(new PrintError('This computer could not send the printout to the printer' + (detail ? ': ' + detail : '.')));
    });
  });

/**
 * A printer installed on this computer, by its name. The bytes go to it untouched: on macOS and Linux through
 * `lp -o raw`, on Windows by copying to the printer's share name (the printer has to be shared under that name).
 */
async function sendToQueue(name: string, data: Buffer, timeoutMs: number): Promise<void> {
  // The name ends up on a command line, so only plain printer names are accepted.
  if (!/^[\w][\w .-]{0,99}$/.test(name)) throw new PrintError('That printer name cannot be used. Use letters, digits, spaces, dots and dashes only.');
  const file = path.join(tmpdir(), 'pos-print-' + process.pid + '-' + Date.now() + '-' + Math.round(Math.random() * 1e6) + '.bin');
  await writeFile(file, data);
  try {
    if (process.platform === 'win32') await run('cmd.exe', ['/d', '/c', 'copy', '/b', file, '\\\\localhost\\' + name], timeoutMs);
    else await run('lp', ['-d', name, '-o', 'raw', file], timeoutMs);
  } finally {
    await rm(file, { force: true });
  }
}

const isDevice = (value: string) => value.startsWith('/') || value.startsWith('\\\\.\\') || /^COM\d+$/i.test(value);

/** Sends the bytes to the printer. Resolves when the printer (or the computer's print system) has taken them. */
export async function sendToPrinter(target: PrintTarget, data: Buffer, limits: SendLimits = {}): Promise<void> {
  const timeoutMs = limits.timeoutMs ?? PRINT_TIMEOUT_MS;
  if (target.connection === 'NETWORK') {
    if (!target.host) throw new PrintError('This printer has no address. Set it in the printer settings.');
    const port = target.port ?? 9100;
    const allowed = limits.anyPort || (port >= PRINTER_PORTS.from && port <= PRINTER_PORTS.to) || (limits.extraPorts ?? []).includes(port);
    if (!allowed) {
      throw new PrintError('The print bridge only prints to ports 9100 to 9109. To use port ' + port + ', add it to PRINT_BRIDGE_ALLOW_PORTS on the bridge computer.');
    }
    return sendToNetwork(target.host, port, data, timeoutMs);
  }
  const device = target.devicePath;
  if (!device) throw new PrintError('This printer has no device set. Set it in the printer settings.');
  if (!isDevice(device)) return sendToQueue(device, data, timeoutMs);
  if (!PRINTER_DEVICES.some((pattern) => pattern.test(device)) && !(limits.extraDevices ?? []).includes(device)) {
    throw new PrintError('The print bridge does not print to "' + device + '". If it is a printer, add it to PRINT_BRIDGE_ALLOW_DEVICES on the bridge computer.');
  }
  return sendToDevice(device, data, timeoutMs);
}
