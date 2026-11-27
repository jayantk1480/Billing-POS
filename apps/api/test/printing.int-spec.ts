import { randomUUID } from 'node:crypto';
import type { BridgeJob, PrintDocument } from '@pos/types';
import { billed, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, ORIGIN } from './support/harness.js';

const textOf = (document: PrintDocument) => document.lines.flatMap((entry) => (entry.kind === 'text' ? [entry.text] : [])).join('\n');

/** Printers, the print bridge and the print queue. */
describe('printing', () => {
  let h: Harness;
  let s: Scene;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    s = await scene(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const network = (name: string, role: 'RECEIPT' | 'KOT', extra: object = {}) => ({ name, role, connection: 'NETWORK', host: '192.168.1.50', ...extra });
  const addPrinter = async (body: object, client = s.owner) => (await client.post('/printers', body).expect(201)).body;
  const addBridge = async (client = s.owner, name = 'Counter PC') => (await client.post('/print-bridges', { name }).expect(201)).body as { id: string; token: string };
  /** What the bridge program does: ask for work, with its token. */
  const claim = (token: string) => h.client().agent.post('/api/v1/print-bridge/claim').set('Authorization', 'Bridge ' + token).send({ version: '1.0.0' });
  const report = (token: string, jobId: string, body: object) =>
    h.client().agent.post('/api/v1/print-bridge/jobs/' + jobId + '/result').set('Authorization', 'Bridge ' + token).send(body);
  const jobsOf = async (token: string) => (await claim(token).expect(200)).body.jobs as BridgeJob[];
  /** Lets a job that is waiting out its retry delay be taken straight away. */
  const skipDelay = () => h.prisma.printJob.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  async function paidBill() {
    const made = await billed(s.cashier, [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)]);
    await pay(s.cashier, made.invoice.id, [{ method: 'CASH', amountPaise: made.invoice.totalPaise, tenderedPaise: 100_000 }]).expect(200);
    return made;
  }
  /** A receipt printer and a bridge that has just checked in. */
  async function ready(extra: object = {}) {
    const printer = await addPrinter(network('Counter', 'RECEIPT', extra));
    const bridge = await addBridge();
    await claim(bridge.token).expect(200);
    return { printer, token: bridge.token };
  }

  describe('printers', () => {
    it('adds, changes and removes printers, with one default for each kind', async () => {
      const first = await addPrinter(network('Counter', 'RECEIPT'));
      expect(first).toMatchObject({ name: 'Counter', role: 'RECEIPT', connection: 'NETWORK', host: '192.168.1.50', port: 9100, paperWidth: 'MM80', isDefault: true, isActive: true, stations: [] });
      const second = await addPrinter({ name: 'Bar', role: 'RECEIPT', connection: 'USB', devicePath: '/dev/usb/lp0', paperWidth: 'MM58' });
      expect(second).toMatchObject({ isDefault: false, host: null, port: null, devicePath: '/dev/usb/lp0', paperWidth: 'MM58' });
      const kitchen = await addPrinter(network('Kitchen', 'KOT', { host: 'kitchen-printer.local', port: 9101 }));
      expect(kitchen).toMatchObject({ isDefault: true, port: 9101 });

      // A new default takes over from the old one, within its own kind only.
      await s.owner.patch('/printers/' + second.id, { isDefault: true }).expect(200);
      const listed = (await s.owner.get('/printers').expect(200)).body as { name: string; isDefault: boolean }[];
      expect(Object.fromEntries(listed.map((printer) => [printer.name, printer.isDefault]))).toEqual({ Counter: false, Bar: true, Kitchen: true });

      // Changing the connection drops what belonged to the old one.
      const moved = (await s.owner.patch('/printers/' + first.id, { connection: 'BLUETOOTH', devicePath: 'COM5' }).expect(200)).body;
      expect(moved).toMatchObject({ connection: 'BLUETOOTH', devicePath: 'COM5', host: null, port: null });

      await s.owner.patch('/stations/' + s.fx.station.id, { printerId: kitchen.id }).expect(200);
      expect((await s.owner.get('/printers').expect(200)).body.find((printer: { id: string }) => printer.id === kitchen.id).stations).toEqual(['Main Kitchen']);
      // Removing a printer leaves its station without one, not broken.
      await s.owner.delete('/printers/' + kitchen.id).expect(204);
      expect((await s.owner.get('/stations').expect(200)).body[0]).toMatchObject({ printerId: null });
      expect(await h.prisma.auditLog.count({ where: { action: { startsWith: 'printer.' } } })).toBe(6);
    });

    it('refuses incomplete or duplicate printers, strangers and other restaurants', async () => {
      expect((await s.owner.post('/printers', { name: 'Counter', role: 'RECEIPT', connection: 'NETWORK' })).status).toBe(400);
      expect((await s.owner.post('/printers', { name: 'Counter', role: 'RECEIPT', connection: 'NETWORK', host: 'not a host!' })).status).toBe(400);
      expect((await s.owner.post('/printers', { name: 'Counter', role: 'RECEIPT', connection: 'USB' })).status).toBe(400);
      expect((await s.owner.post('/printers', { name: 'Counter', role: 'LABEL', connection: 'BROWSER' })).status).toBe(400);
      const printer = await addPrinter(network('Counter', 'RECEIPT'));
      expect((await s.owner.post('/printers', network('counter', 'KOT'))).body.code).toBe('NAME_TAKEN');
      expect((await s.owner.patch('/printers/' + printer.id, { host: '' })).body.code).toBe('PRINTER_HOST_REQUIRED');
      expect((await s.owner.patch('/printers/' + printer.id, { connection: 'USB' })).body.code).toBe('PRINTER_DEVICE_REQUIRED');

      expect((await s.cashier.get('/printers')).status).toBe(403);
      expect((await s.cashier.post('/printers', network('Mine', 'RECEIPT'))).status).toBe(403);
      expect((await s.cashier.post('/print-bridges', { name: 'Mine' })).status).toBe(403);

      const other = await scene(h, 'b');
      expect((await other.owner.get('/printers').expect(200)).body).toEqual([]);
      expect((await other.owner.patch('/printers/' + printer.id, { name: 'Taken' })).status).toBe(404);
      expect((await other.owner.delete('/printers/' + printer.id)).status).toBe(404);
      expect((await other.owner.post('/printers/' + printer.id + '/test')).status).toBe(404);
      // A station cannot be pointed at another restaurant's printer.
      expect((await other.owner.patch('/stations/' + other.fx.station.id, { printerId: printer.id })).body.code).toBe('PRINTER_NOT_FOUND');
    });
  });

  describe('the bridge', () => {
    it('signs in with the token shown once, and shows as connected while it keeps asking for work', async () => {
      const made = (await s.owner.post('/print-bridges', { name: 'Counter PC' }).expect(201)).body;
      expect(made.token).toMatch(/^pb_[\w-]{40,}$/);
      expect(made).toMatchObject({ name: 'Counter PC', online: false, lastSeenAt: null });
      // Only a hash is kept, so the token cannot be read back out.
      const stored = await h.prisma.printBridge.findFirstOrThrow();
      expect(stored.tokenHash).not.toContain(made.token);
      expect(JSON.stringify((await s.owner.get('/print-bridges').expect(200)).body)).not.toContain(made.token);
      expect((await s.cashier.get('/printing/status').expect(200)).body).toEqual({ bridgeOnline: false, receiptPrinter: null, kitchenPrinters: false });

      expect((await claim(made.token).expect(200)).body).toEqual({ jobs: [] });
      expect((await s.owner.get('/print-bridges').expect(200)).body[0]).toMatchObject({ online: true, version: '1.0.0' });
      const printer = await addPrinter(network('Counter', 'RECEIPT', { paperWidth: 'MM58' }));
      await addPrinter({ name: 'Browser KOT', role: 'KOT', connection: 'BROWSER' });
      // A printer reached through the browser's print dialog does not count as a bridge printer.
      expect((await s.cashier.get('/printing/status').expect(200)).body).toEqual({ bridgeOnline: true, receiptPrinter: { id: printer.id, name: 'Counter', paperWidth: 'MM58' }, kitchenPrinters: false });

      // Half a minute of silence and it counts as disconnected.
      await h.prisma.printBridge.updateMany({ data: { lastSeenAt: new Date(Date.now() - 31_000) } });
      expect((await s.cashier.get('/printing/status').expect(200)).body.bridgeOnline).toBe(false);
    });

    it('is turned away without a valid token, and once it has been removed', async () => {
      const bridge = await addBridge();
      expect((await h.client().agent.post('/api/v1/print-bridge/claim').send({})).status).toBe(401);
      expect((await claim('pb_wrong')).status).toBe(401);
      // A signed-in user is not a bridge, and a bridge token opens nothing else.
      expect((await s.owner.post('/print-bridge/claim', {})).status).toBe(401);
      expect((await h.client().agent.get('/api/v1/printers').set('Origin', ORIGIN).set('Authorization', 'Bridge ' + bridge.token)).status).toBe(401);
      expect((await h.client().agent.get('/api/v1/printers').set('Origin', ORIGIN).set('Authorization', 'Bearer ' + bridge.token)).status).toBe(401);

      await s.owner.delete('/print-bridges/' + bridge.id).expect(204);
      expect((await claim(bridge.token)).status).toBe(401);
      expect((await s.owner.post('/print-bridges', { name: 'Counter PC' })).status).toBe(201);
      expect((await s.owner.post('/print-bridges', { name: 'counter pc' })).body.code).toBe('NAME_TAKEN');
    });

    it('only ever sees and settles the jobs of its own restaurant', async () => {
      const { token } = await ready();
      const { invoice } = await paidBill();
      const job = (await s.cashier.post('/invoices/' + invoice.id + '/print', {}).expect(201)).body;

      const other = await scene(h, 'b');
      const theirs = await addBridge(other.owner);
      expect(await jobsOf(theirs.token)).toEqual([]);
      expect((await report(theirs.token, job.id, { ok: true })).status).toBe(404);
      expect((await other.owner.post('/print-jobs/' + job.id + '/retry')).status).toBe(404);
      expect((await other.owner.get('/print-jobs').expect(200)).body.total).toBe(0);
      expect((await h.prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('QUEUED');
      expect(await jobsOf(token)).toHaveLength(1);
    });
  });

  describe('printing a bill', () => {
    it('says why when there is no printer or the bridge is not connected', async () => {
      const { invoice } = await paidBill();
      const none = await s.cashier.post('/invoices/' + invoice.id + '/print', {});
      expect(none.status).toBe(422);
      expect(none.body.code).toBe('NO_PRINTER');
      await addPrinter(network('Counter', 'RECEIPT'));
      const offline = await s.cashier.post('/invoices/' + invoice.id + '/print', {});
      expect(offline.status).toBe(409);
      expect(offline.body.code).toBe('PRINT_BRIDGE_OFFLINE');
      // Nothing was queued and the bill does not count as printed.
      expect(await h.prisma.printJob.count()).toBe(0);
      expect((await s.cashier.get('/invoices/' + invoice.id).expect(200)).body.printCount).toBe(0);
    });

    it('queues the bill, hands it to the bridge laid out for the printer\'s paper, and records that it printed', async () => {
      const { printer, token } = await ready();
      const { invoice } = await paidBill();
      const queued = (await s.cashier.post('/invoices/' + invoice.id + '/print', {}).expect(201)).body;
      expect(queued).toMatchObject({ type: 'RECEIPT', status: 'QUEUED', title: 'Bill ' + invoice.invoiceNumber, printerName: 'Counter', isReprint: false, attempts: 0 });
      expect((await s.cashier.get('/invoices/' + invoice.id).expect(200)).body.printCount).toBe(1);

      const [job] = await jobsOf(token);
      expect(job).toMatchObject({ id: queued.id, attempt: 1, target: { id: printer.id, connection: 'NETWORK', host: '192.168.1.50', port: 9100 } });
      const document = job!.document;
      expect(document).toMatchObject({ columns: 48, copies: 1, openDrawer: true });
      const text = textOf(document);
      expect(text).toContain('TAX INVOICE');
      expect(text).toContain(invoice.invoiceNumber);
      expect(text).toContain('GSTIN: 27AAAAA0000A1Z5');
      expect(text).toMatch(/Paneer Tikka\s+2\s+260\.00\s+520\.00/);
      expect(text).toMatch(/TOTAL\s+Rs\.\s?605\.00/);
      expect(text).toMatch(/Paid by Cash\s+605\.00/);
      expect(text).not.toContain('₹');
      // Every line fits the paper.
      for (const entry of document.lines) if (entry.kind === 'text') expect(entry.text.length).toBeLessThanOrEqual(entry.size === 'large' || entry.size === 'wide' ? 24 : 48);
      // Taken once: the bridge is not handed the same job again while it is printing.
      expect(await jobsOf(token)).toEqual([]);

      await report(token, job!.id, { ok: true }).expect(204);
      const done = (await s.owner.get('/print-jobs').expect(200)).body.items[0];
      expect(done).toMatchObject({ id: queued.id, status: 'DONE', attempts: 1, lastError: null, requestedByName: 'Cashier' });
      expect(done.printedAt).toEqual(expect.any(String));
      expect((await s.owner.get('/printers').expect(200)).body[0]).toMatchObject({ lastStatus: 'ok', lastError: null });

      // A second copy is a duplicate: marked as one, and the drawer stays shut.
      const again = (await s.cashier.post('/invoices/' + invoice.id + '/print', {}).expect(201)).body;
      expect(again.isReprint).toBe(true);
      const [copy] = await jobsOf(token);
      expect(copy!.document.openDrawer).toBe(false);
      expect(textOf(copy!.document)).toContain('(Duplicate copy)');
      expect(await h.prisma.auditLog.count({ where: { action: 'invoice.reprinted' } })).toBe(1);
    });

    it('lays the same bill out for narrow paper, with the layout the owner chose', async () => {
      const { token } = await ready({ paperWidth: 'MM58' });
      await s.owner.patch('/settings', { upiVpa: 'spice@okbank' }).expect(200);
      expect((await s.owner.get('/print-layouts').expect(200)).body).toEqual({
        receipt: { headerNote: null, showCustomer: true, showHsn: false, showTaxBreakup: true, showAmountInWords: false, showUpiQr: true, openDrawer: true, copies: 1 },
        kot: { largeItems: false, showOrderedBy: true, copies: 1 },
      });
      const changed = await s.owner.patch('/print-layouts', { receipt: { headerNote: 'Pure veg since 1998', showHsn: true, showTaxBreakup: false, copies: 2, openDrawer: false }, kot: { copies: 2 } }).expect(200);
      expect(changed.body.receipt).toMatchObject({ headerNote: 'Pure veg since 1998', showHsn: true, showCustomer: true, copies: 2 });
      expect(changed.body.kot).toEqual({ largeItems: false, showOrderedBy: true, copies: 2 });
      expect((await s.owner.patch('/print-layouts', { receipt: { copies: 9 } })).status).toBe(400);
      expect((await s.cashier.patch('/print-layouts', { receipt: { copies: 1 } })).status).toBe(403);

      // Not yet paid, so the bill carries a QR code for the amount due.
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      await s.cashier.post('/invoices/' + invoice.id + '/print', {}).expect(201);
      const [job] = await jobsOf(token);
      const document = job!.document;
      expect(document).toMatchObject({ columns: 32, copies: 2, openDrawer: false });
      const text = textOf(document);
      expect(text).toContain('Pure veg since 1998');
      expect(text).toContain('Paneer Tikka [996331]');
      expect(text).toMatch(/GST\s+13\.00/);
      expect(text).not.toContain('CGST');
      expect(text).toMatch(/Balance due\s+273\.00/);
      expect(document.lines.find((entry) => entry.kind === 'qr')).toEqual({ kind: 'qr', data: expect.stringMatching(/^upi:\/\/pay\?pa=spice%40okbank&pn=Test%20Restaurant%20A&am=273\.00&cu=INR&tn=/) });
      for (const entry of document.lines) if (entry.kind === 'text') expect(entry.text.length).toBeLessThanOrEqual(entry.size === 'large' || entry.size === 'wide' ? 16 : 32);
    });

    it('tries a failing printer three times, then gives up and says so; the job can be sent again', async () => {
      const { token } = await ready();
      const { invoice } = await paidBill();
      const queued = (await s.cashier.post('/invoices/' + invoice.id + '/print', {}).expect(201)).body;
      for (const attempt of [1, 2, 3]) {
        await skipDelay();
        const [job] = await jobsOf(token);
        expect(job).toMatchObject({ id: queued.id, attempt });
        await report(token, job!.id, { ok: false, error: 'Printer is out of paper' }).expect(204);
        const row = await h.prisma.printJob.findUniqueOrThrow({ where: { id: queued.id } });
        expect(row.status).toBe(attempt < 3 ? 'QUEUED' : 'FAILED');
        // It waits before trying again, a little longer each time.
        if (attempt < 3) expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 1000);
      }
      expect((await s.cashier.get('/print-jobs?status=FAILED').expect(200)).body.items[0]).toMatchObject({ id: queued.id, attempts: 3, lastError: 'Printer is out of paper' });
      expect((await s.owner.get('/printers').expect(200)).body[0]).toMatchObject({ lastStatus: 'error', lastError: 'Printer is out of paper' });
      // A late report about a settled job changes nothing.
      await report(token, queued.id, { ok: true }).expect(204);
      expect((await h.prisma.printJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('FAILED');

      const again = (await s.cashier.post('/print-jobs/' + queued.id + '/retry').expect(201)).body;
      expect(again).toMatchObject({ status: 'QUEUED', title: queued.title, isReprint: true });
      expect(again.id).not.toBe(queued.id);
      expect((await s.cashier.post('/print-jobs/' + again.id + '/retry')).body.code).toBe('PRINT_JOB_NOT_FAILED');
      const [job] = await jobsOf(token);
      await report(token, job!.id, { ok: true }).expect(204);
      expect((await h.prisma.printJob.findUniqueOrThrow({ where: { id: again.id } })).status).toBe('DONE');
    });

    it('hands a job out again when the bridge took it and went silent, and gives up on one nobody printed in time', async () => {
      const { token } = await ready();
      const { invoice } = await paidBill();
      const queued = (await s.cashier.post('/invoices/' + invoice.id + '/print', {}).expect(201)).body;
      expect(await jobsOf(token)).toHaveLength(1);
      expect(await jobsOf(token)).toEqual([]);
      await h.prisma.printJob.update({ where: { id: queued.id }, data: { claimedAt: new Date(Date.now() - 60_000) } });
      expect((await jobsOf(token))[0]).toMatchObject({ id: queued.id, attempt: 2 });

      // A quarter of an hour later it is no use printing it any more.
      await h.prisma.printJob.update({ where: { id: queued.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000), claimedAt: new Date(Date.now() - 60_000) } });
      expect(await jobsOf(token)).toEqual([]);
      expect(await h.prisma.printJob.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'FAILED', lastError: 'No print bridge picked this up in time.' });
    });

    it('lays the bill out for a printer connected to the billing device, queueing and counting nothing', async () => {
      const { invoice } = await paidBill();
      // No bridge, no printers set up: the layout is still served, for the device's own printer.
      const document = (await s.cashier.get('/invoices/' + invoice.id + '/print-document?width=MM58').expect(200)).body as PrintDocument;
      expect(document).toMatchObject({ columns: 32, copies: 1, openDrawer: true });
      const text = textOf(document);
      expect(text).toContain(invoice.invoiceNumber);
      expect(text).toMatch(/TOTAL\s+Rs\.\s?605\.00/);
      // The wide roll is the default, and asking lays the bill out without queueing a job or counting a print.
      expect(((await s.cashier.get('/invoices/' + invoice.id + '/print-document').expect(200)).body as PrintDocument).columns).toBe(48);
      expect((await s.cashier.get('/invoices/' + invoice.id + '/print-document?width=A4')).status).toBe(400);
      expect(await h.prisma.printJob.count()).toBe(0);
      expect((await s.cashier.get('/invoices/' + invoice.id).expect(200)).body.printCount).toBe(0);

      const register = (await s.cashier.post('/registers/open', { openingCashPaise: 50_000 }).expect(201)).body;
      const report = (await s.cashier.get('/registers/' + register.id + '/print-document?width=MM80').expect(200)).body as PrintDocument;
      expect(textOf(report)).toMatch(/Opening cash\s+500\.00/);

      const other = await scene(h, 'b');
      expect((await other.cashier.get('/invoices/' + invoice.id + '/print-document')).status).toBe(404);
      expect((await other.cashier.get('/registers/' + register.id + '/print-document')).status).toBe(404);
    });

    it('prints a test page, a credit note and a register report', async () => {
      const { printer, token } = await ready();
      const test = (await s.owner.post('/printers/' + printer.id + '/test').expect(201)).body;
      expect(test).toMatchObject({ type: 'TEST', title: 'Test page for Counter' });
      expect((await s.cashier.post('/printers/' + printer.id + '/test')).status).toBe(403);

      const { invoice } = await paidBill();
      const payment = await h.prisma.payment.findFirstOrThrow();
      await s.owner.post('/invoices/' + invoice.id + '/refunds', { id: randomUUID(), paymentId: payment.id, amountPaise: 10000, reason: 'Cold food' }).expect(200);
      const refund = await h.prisma.refund.findFirstOrThrow();
      await s.owner.post('/invoices/' + invoice.id + '/refunds/' + refund.id + '/print', {}).expect(201);
      expect((await s.owner.post('/invoices/' + invoice.id + '/refunds/' + randomUUID() + '/print', {})).status).toBe(404);

      const register = (await s.cashier.post('/registers/open', { openingCashPaise: 50_000 }).expect(201)).body;
      await s.cashier.post('/registers/' + register.id + '/close', { countedCashPaise: 49_000, denominations: { 500: 0, 200: 2, 50: 1, 10: 4 }, notes: 'Short by ten' }).expect(200);
      await s.cashier.post('/registers/' + register.id + '/print', {}).expect(201);

      const jobs = await jobsOf(token);
      expect(jobs.map((job) => job.title)).toEqual(['Test page for Counter', 'Credit note ' + refund.creditNoteNumber, 'Register report for Cashier']);
      expect(textOf(jobs[0]!.document)).toContain('123456789012345678901234567890123456789012345678');
      const note = textOf(jobs[1]!.document);
      expect(note).toContain('CREDIT NOTE');
      expect(note).toMatch(/Against bill\s+A1\//);
      expect(note).toMatch(/REFUNDED\s+Rs\.\s?100\.00/);
      const reportText = textOf(jobs[2]!.document);
      expect(reportText).toMatch(/Opening cash\s+500\.00/);
      expect(reportText).toMatch(/Short\s+10\.00/);
      expect(reportText).toMatch(/Rs\.200 x 2\s+400\.00/);
      expect(reportText).toContain('Notes: Short by ten');
    });
  });

  describe('kitchen tickets', () => {
    /** Paneer goes to the main kitchen, cola to the bar. */
    async function kitchen() {
      const bar = await h.prisma.kitchenStation.create({ data: { restaurantId: s.fx.restaurant.id, name: 'Bar' } });
      await h.prisma.product.update({ where: { id: s.menu.paneer.id }, data: { stationId: s.fx.station.id } });
      await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { stationId: bar.id } });
      return { bar };
    }
    const fire = async (items: object[]) => {
      const order = (await saveOrder(s.cashier, { items }).expect(200)).body;
      return (await s.cashier.post('/orders/' + order.id + '/kots').expect(200)).body as { id: string; stationName: string; printCount: number }[];
    };

    it('prints each new ticket at its station\'s printer, and tells the billing screen it did', async () => {
      const { bar } = await kitchen();
      const hot = await addPrinter(network('Kitchen', 'KOT'));
      const cold = await addPrinter(network('Bar printer', 'KOT', { host: '192.168.1.61', paperWidth: 'MM58' }));
      await s.owner.patch('/stations/' + bar.id, { printerId: cold.id }).expect(200);
      const bridge = await addBridge();
      await claim(bridge.token).expect(200);

      const tickets = await fire([line(s.menu.paneer.id, 2, { notes: 'Less spicy' }), line(s.menu.cola.id, 1)]);
      // Counted as printed: the billing screen leaves these alone.
      expect(tickets.map((ticket) => [ticket.stationName, ticket.printCount])).toEqual([['Main Kitchen', 1], ['Bar', 1]]);
      const jobs = await jobsOf(bridge.token);
      // The bar has its own printer; the main kitchen uses the default kitchen printer.
      expect(jobs.map((job) => [job.target.id, job.document.columns])).toEqual([[hot.id, 48], [cold.id, 32]]);
      const ticket = textOf(jobs[0]!.document);
      expect(ticket).toContain('MAIN KITCHEN');
      expect(ticket).toContain('2 x Paneer Tikka');
      expect(ticket).toContain('> Less spicy');
      expect(ticket).not.toContain('Cola');
      expect(ticket).not.toContain('(Reprint)');
      expect(textOf(jobs[1]!.document)).toContain('1 x Cola');

      // Sending one again by hand is a reprint.
      await s.cashier.post('/kots/' + tickets[0]!.id + '/print', {}).expect(201);
      expect(textOf((await jobsOf(bridge.token))[0]!.document)).toContain('(Reprint)');
    });

    it('leaves tickets to the billing screen when nothing can print them', async () => {
      await kitchen();
      // No printers at all.
      expect((await fire([line(s.menu.paneer.id, 1)])).map((ticket) => ticket.printCount)).toEqual([0]);
      // A printer, but no bridge connected.
      await addPrinter(network('Kitchen', 'KOT'));
      expect((await fire([line(s.menu.paneer.id, 1)])).map((ticket) => ticket.printCount)).toEqual([0]);
      // Connected, but the restaurant does not print tickets automatically.
      const bridge = await addBridge();
      await claim(bridge.token).expect(200);
      await s.owner.patch('/settings', { autoPrintKot: false }).expect(200);
      expect((await fire([line(s.menu.paneer.id, 1)])).map((ticket) => ticket.printCount)).toEqual([0]);
      expect(await h.prisma.printJob.count()).toBe(0);

      await s.owner.patch('/settings', { autoPrintKot: true }).expect(200);
      expect((await fire([line(s.menu.paneer.id, 1)])).map((ticket) => ticket.printCount)).toEqual([1]);
      expect(await h.prisma.printJob.count()).toBe(1);
    });

    it('prints kitchen tickets only from KOT: billing neither makes nor prints one', async () => {
      await kitchen();
      await addPrinter(network('Kitchen', 'KOT'));
      const bridge = await addBridge();
      await claim(bridge.token).expect(200);
      const kotJobs = () => h.prisma.printJob.count({ where: { type: 'KOT' } });

      // "When KOT is pressed", the default: KOT prints at the station printer; billing straight away makes no ticket.
      expect((await s.owner.get('/settings').expect(200)).body).toMatchObject({ autoPrintKot: true, autoPrintReceipt: true });
      expect((await fire([line(s.menu.paneer.id, 1)])).map((ticket) => ticket.printCount)).toEqual([1]);
      expect(await kotJobs()).toBe(1);
      const billedOnly = await billed(s.cashier, [line(s.menu.paneer.id, 2)]);
      expect(await h.prisma.kot.count({ where: { orderId: billedOnly.order.id } })).toBe(0);
      expect(await kotJobs()).toBe(1);

      // "Don't print": KOT still sends to the kitchen display, and nothing prints.
      await s.owner.patch('/settings', { autoPrintKot: false }).expect(200);
      expect((await fire([line(s.menu.paneer.id, 1)])).map((ticket) => ticket.printCount)).toEqual([0]);
      expect(await kotJobs()).toBe(1);
    });

    it('lays a ticket out for a printer connected to the billing device', async () => {
      await kitchen();
      const [ticket] = await fire([line(s.menu.paneer.id, 2, { notes: 'No onion' })]);
      const document = (await s.cashier.get('/kots/' + ticket!.id + '/print-document?width=MM58').expect(200)).body as PrintDocument;
      expect(document.columns).toBe(32);
      const text = textOf(document);
      expect(text).toContain('MAIN KITCHEN');
      expect(text).toContain('2 x Paneer Tikka');
      expect(text).toContain('> No onion');
      // The screen reports the print separately, so asking for the layout counts nothing.
      expect(await h.prisma.printJob.count()).toBe(0);
      expect((await h.prisma.kot.findUniqueOrThrow({ where: { id: ticket!.id } })).printCount).toBe(0);
      const other = await scene(h, 'b');
      expect((await other.cashier.get('/kots/' + ticket!.id + '/print-document')).status).toBe(404);
    });

    it('moves a ticket to the fallback printer when the station printer keeps failing', async () => {
      await kitchen();
      const hot = await addPrinter(network('Kitchen', 'KOT'));
      const spare = await addPrinter(network('Spare', 'KOT', { host: '192.168.1.62', paperWidth: 'MM58' }));
      await s.owner.patch('/stations/' + s.fx.station.id, { printerId: hot.id, fallbackPrinterId: spare.id }).expect(200);
      const bridge = await addBridge();
      await claim(bridge.token).expect(200);
      await fire([line(s.menu.paneer.id, 1)]);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await skipDelay();
        const [job] = await jobsOf(bridge.token);
        expect(job).toMatchObject({ attempt, target: { id: hot.id } });
        await report(bridge.token, job!.id, { ok: false, error: 'Connection refused' }).expect(204);
      }
      // Same ticket, now at the spare printer and laid out for its narrower paper.
      const [moved] = await jobsOf(bridge.token);
      expect(moved).toMatchObject({ attempt: 1, target: { id: spare.id, host: '192.168.1.62' }, document: { columns: 32 } });
      await report(bridge.token, moved!.id, { ok: true }).expect(204);
      const row = await h.prisma.printJob.findFirstOrThrow();
      expect(row).toMatchObject({ status: 'DONE', printerId: spare.id, fallbackTried: true });
      const printers = (await s.owner.get('/printers').expect(200)).body as { name: string; lastStatus: string }[];
      expect(Object.fromEntries(printers.map((printer) => [printer.name, printer.lastStatus]))).toEqual({ Kitchen: 'error', Spare: 'ok' });
    });
  });
});
