import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BridgeJob, PrintDocument, PrintTarget } from '@pos/types';
import { createBridge, NotPairedError } from './bridge.js';
import { encode } from './escpos.js';
import { PrintError, sendToPrinter } from './transport.js';

const receipt: PrintDocument = {
  columns: 32, copies: 1, openDrawer: false,
  lines: [
    { kind: 'text', text: 'SPICE GARDEN', align: 'center', bold: true, size: 'large' },
    { kind: 'rule' },
    { kind: 'text', text: 'Paneer Tikka               260.00' },
    { kind: 'feed', lines: 2 },
    { kind: 'qr', data: 'upi://pay?pa=spice@okbank&am=273.00' },
  ],
};

/** A network thermal printer: accepts a connection on a port and keeps what it is sent. */
async function printerEmulator() {
  const received: Buffer[] = [];
  const server: TcpServer = createTcpServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const target: PrintTarget = { id: 'p1', name: 'Counter', connection: 'NETWORK', host: '127.0.0.1', port, devicePath: null };
  return { received, target, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The API as the bridge sees it: hands out the queued jobs once, and remembers what was reported. */
async function apiStandIn(token: string, queued: BridgeJob[]) {
  const reports: { id: string; ok: boolean; error?: string }[] = [];
  const hellos: unknown[] = [];
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
  };
  const server: HttpServer = createHttpServer((req, res) => {
    void (async () => {
      const body = await read(req);
      if (req.headers.authorization !== 'Bridge ' + token) {
        res.writeHead(401).end('{}');
      } else if (req.url === '/api/v1/print-bridge/claim') {
        hellos.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jobs: queued.splice(0) }));
      } else {
        const id = /jobs\/([^/]+)\/result$/.exec(req.url ?? '')?.[1] ?? '';
        reports.push({ id, ...(body as { ok: boolean; error?: string }) });
        res.writeHead(204).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { url, reports, hellos, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('ESC/POS encoding', () => {
  it('resets the printer, styles each line, and cuts at the end', () => {
    const bytes = encode(receipt);
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    // Centred, bold, double width and height, then the text and a line feed.
    const title = Buffer.from([0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11, ...Buffer.from('SPICE GARDEN'), 0x0a]);
    expect(bytes.includes(title)).toBe(true);
    expect(bytes.includes(Buffer.from('-'.repeat(32) + '\n'))).toBe(true);
    expect(bytes.includes(Buffer.from([0x1b, 0x64, 2]))).toBe(true);
    // The QR code carries its data and is followed by the print command.
    expect(bytes.includes(Buffer.from('upi://pay?pa=spice@okbank&am=273.00'))).toBe(true);
    expect(bytes.includes(Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]))).toBe(true);
    expect([...bytes.subarray(-7)]).toEqual([0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0x00]);
    // No drawer kick unless asked for.
    expect(bytes.includes(Buffer.from([0x1b, 0x70, 0x00]))).toBe(false);
  });

  it('prints every copy, opens the drawer once, and never sends characters the printer cannot show', () => {
    const bytes = encode({ ...receipt, copies: 2, openDrawer: true, lines: [{ kind: 'text', text: 'Total ₹273 café' }] });
    const count = (needle: Buffer) => bytes.toString('latin1').split(needle.toString('latin1')).length - 1;
    expect(count(Buffer.from([0x1b, 0x40]))).toBe(2);
    expect(count(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(2);
    expect(count(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(1);
    expect(bytes.includes(Buffer.from('Total ?273 caf?'))).toBe(true);
    expect(bytes.every((byte) => byte < 0x80 || byte === 0xfa)).toBe(true);
  });
});

describe('sending to a printer', () => {
  it('delivers the bytes to a network printer', async () => {
    const printer = await printerEmulator();
    const data = encode(receipt);
    await sendToPrinter(printer.target, data, { anyPort: true });
    await vi.waitFor(() => expect(printer.received).toHaveLength(1));
    expect(printer.received[0]!.equals(data)).toBe(true);
    await printer.close();
  });

  it('says what is wrong in words for the counter when the printer cannot be reached', async () => {
    const printer = await printerEmulator();
    await printer.close();
    // Nothing listens on that port any more.
    await expect(sendToPrinter(printer.target, Buffer.from('x'), { anyPort: true })).rejects.toThrow(new PrintError('The printer refused the connection. Check that it is switched on.'));
    await expect(sendToPrinter({ ...printer.target, host: 'no-such-printer.invalid', port: 9100 }, Buffer.from('x'))).rejects.toThrow(/address was not found|could not be reached/);
    await expect(sendToPrinter({ ...printer.target, host: null }, Buffer.from('x'))).rejects.toThrow(/no address/);
  });

  it('writes to a USB or Bluetooth device, and reports one that is not there', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
    const device = path.join(folder, 'lp0');
    const target: PrintTarget = { id: 'p2', name: 'USB printer', connection: 'USB', host: null, port: null, devicePath: device };
    await sendToPrinter(target, encode(receipt), { extraDevices: [device] });
    expect((await readFile(device)).equals(encode(receipt))).toBe(true);

    const missing = path.join(folder, 'missing', 'lp1');
    await expect(sendToPrinter({ ...target, devicePath: missing }, Buffer.from('x'), { extraDevices: [missing] })).rejects.toThrow(/was not found on this computer/);
    await expect(sendToPrinter({ ...target, devicePath: null }, Buffer.from('x'))).rejects.toThrow(/no device set/);
    // A printer name goes onto a command line, so anything but a plain name is refused before it gets there.
    await expect(sendToPrinter({ ...target, devicePath: 'Printer & del *' }, Buffer.from('x'))).rejects.toThrow(/cannot be used/);
    await rm(folder, { recursive: true });
  });
});

describe('what the bridge refuses to print to', () => {
  // Printer settings arrive from the server. Whoever controls them must not be able to aim the bridge at
  // other services or at files on the counter computer.
  it('other services on the network', async () => {
    const service = await printerEmulator();
    const target: PrintTarget = { ...service.target, port: service.port };
    await expect(sendToPrinter(target, Buffer.from('FLUSHALL\r\n'))).rejects.toThrow(/only prints to ports 9100 to 9109/);
    await expect(sendToPrinter({ ...target, port: 6379 }, Buffer.from('x'))).rejects.toThrow(/add it to PRINT_BRIDGE_ALLOW_PORTS/);
    await expect(sendToPrinter({ ...target, port: 22 }, Buffer.from('x'), { extraPorts: [6001] })).rejects.toThrow(PrintError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.received).toEqual([]);
    // Unless the person who installed the bridge allowed that port.
    await sendToPrinter(target, Buffer.from('ok'), { extraPorts: [service.port] });
    await vi.waitFor(() => expect(service.received).toHaveLength(1));
    await service.close();
  });

  it('files and devices that are not printers', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
    const file = path.join(folder, 'startup-script.sh');
    const usb: PrintTarget = { id: 'p3', name: 'USB printer', connection: 'USB', host: null, port: null, devicePath: file };
    await expect(sendToPrinter(usb, Buffer.from('rm -rf ~'))).rejects.toThrow(/does not print to/);
    await expect(readFile(file)).rejects.toThrow();
    for (const devicePath of ['/etc/hosts', '/dev/sda', '/dev/disk0', '/dev/usb/../sda', '/dev/usb/lp0/../../sda', '\\\\.\\PhysicalDrive0']) {
      await expect(sendToPrinter({ ...usb, devicePath }, Buffer.from('x')), devicePath).rejects.toThrow(/does not print to/);
    }
    await rm(folder, { recursive: true });
  });
});

describe('the bridge', () => {
  const job = (id: string, target: PrintTarget, title = 'Bill A1/2627/000001'): BridgeJob => ({ id, title, attempt: 1, target, document: receipt });

  it('takes jobs from the server, prints them, and reports each result', async () => {
    const printer = await printerEmulator();
    const dead: PrintTarget = { ...printer.target, id: 'p9', name: 'Kitchen', port: 1 };
    const api = await apiStandIn('pb_secret', [job('job-1', printer.target), job('job-2', dead, 'Kitchen ticket 4'), job('job-3', printer.target, 'Bill A1/2627/000002')]);
    const lines: string[] = [];
    const bridge = createBridge({ apiUrl: api.url + '/', token: 'pb_secret', version: '1.0.0', limits: { anyPort: true }, log: (message) => lines.push(message) });

    expect(await bridge.pollOnce()).toBe(3);
    expect(api.hellos).toEqual([{ version: '1.0.0' }]);
    await vi.waitFor(() => expect(printer.received).toHaveLength(2));
    expect(printer.received[0]!.equals(encode(receipt))).toBe(true);
    // The printer that could not be reached is reported with a reason; the others are not held up by it.
    expect(api.reports.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'job-1', ok: true },
      { id: 'job-2', ok: false, error: 'The printer refused the connection. Check that it is switched on.' },
      { id: 'job-3', ok: true },
    ]);
    expect(bridge.state).toMatchObject({ connected: true, printed: 2, failed: 1, lastError: null });
    expect(lines.some((line) => line.startsWith('Failed: Kitchen ticket 4 on Kitchen'))).toBe(true);
    // Nothing waiting the second time.
    expect(await bridge.pollOnce()).toBe(0);
    await printer.close();
    await api.close();
  });

  it('keeps an unexpected failure to itself and reports a plain message', async () => {
    const printer = await printerEmulator();
    const api = await apiStandIn('pb_secret', [job('job-1', printer.target)]);
    const bridge = createBridge({
      apiUrl: api.url, token: 'pb_secret', version: '1.0.0',
      send: () => Promise.reject(new Error('EFAULT at 0x7ffe: internal detail')),
    });
    await bridge.pollOnce();
    expect(api.reports).toEqual([{ id: 'job-1', ok: false, error: 'The print bridge could not print this.' }]);
    await printer.close();
    await api.close();
  });

  it('stops and says so when the server does not know its token, and waits when the server is away', async () => {
    const api = await apiStandIn('pb_secret', []);
    const wrong = createBridge({ apiUrl: api.url, token: 'pb_old', version: '1.0.0' });
    await expect(wrong.pollOnce()).rejects.toBeInstanceOf(NotPairedError);
    await api.close();

    const lines: string[] = [];
    const bridge = createBridge({ apiUrl: api.url, token: 'pb_secret', version: '1.0.0', pollMs: 20, log: (message) => lines.push(message) });
    const stop = new AbortController();
    const running = bridge.run(stop.signal);
    await vi.waitFor(() => expect(bridge.state.lastError).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop.abort();
    await running;
    expect(bridge.state.connected).toBe(false);
    // The same problem is logged once, not on every attempt.
    expect(lines.filter((line) => line.startsWith('Not connected'))).toHaveLength(1);
  });
});
