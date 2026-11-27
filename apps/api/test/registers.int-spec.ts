import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import { billed, line, pay, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, PASSWORD } from './support/harness.js';

const TODAY = businessDateOf(new Date());

/** Cash register sessions: opening, taking cash, cash in and out, closing against a count. */
describe('cash register', () => {
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

  const open = (client = s.cashier, openingCashPaise = 100_000) => client.post('/registers/open', { openingCashPaise });
  const current = async (client = s.cashier) => (await client.get('/registers/current').expect(200)).body.register;
  /** A paneer tikka (₹273) billed and paid. */
  async function sale(method = 'CASH', client = s.cashier) {
    const made = await billed(client, [line(s.menu.paneer.id, 1)]);
    await pay(client, made.invoice.id, [{ method, amountPaise: 27300, ...(method === 'CASH' ? { tenderedPaise: 30000 } : {}) }]).expect(200);
    return made;
  }

  describe('opening and taking money', () => {
    it('opens with a float, and counts cash taken while it is open', async () => {
      expect((await s.cashier.get('/registers/current').expect(200)).body).toEqual({ register: null });
      const opened = await open();
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({
        status: 'OPEN', businessDate: TODAY, openingCashPaise: 100_000, expectedCashPaise: 100_000, countedCashPaise: null, variancePaise: null,
        user: { id: s.fx.cashier.id, name: 'Cashier' }, terminal: { code: 'A1' }, takings: [], movements: [],
      });

      await sale('CASH');
      await sale('UPI');
      const now = await current();
      // Only cash is in the drawer; the change handed back never was.
      expect(now).toMatchObject({ cashSalesPaise: 27300, expectedCashPaise: 127_300 });
      expect(now.takings).toEqual([
        { method: 'CASH', count: 1, receivedPaise: 27300, refundedPaise: 0 },
        { method: 'UPI', count: 1, receivedPaise: 27300, refundedPaise: 0 },
      ]);
      expect(await h.prisma.payment.count({ where: { registerSessionId: opened.body.id } })).toBe(2);
      expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'register.opened' } })).userId).toBe(s.fx.cashier.id);
    });

    it('allows one open register per person, and leaves money taken without one outside any register', async () => {
      await sale('CASH');
      expect((await h.prisma.payment.findFirstOrThrow()).registerSessionId).toBeNull();

      await open().expect(201);
      const again = await open();
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('REGISTER_ALREADY_OPEN');
      // Someone else has their own register.
      await open(s.owner, 50_000).expect(201);
      await sale('CASH', s.owner);
      expect((await current(s.owner)).expectedCashPaise).toBe(77_300);
      expect((await current()).expectedCashPaise).toBe(100_000);
    });

    it('refuses cash without an open register when the restaurant requires one', async () => {
      await s.owner.patch('/settings', { registerRequired: true }).expect(200);
      const made = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      const refused = await pay(s.cashier, made.invoice.id, [{ method: 'CASH', amountPaise: 27300 }]);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('REGISTER_NOT_OPEN');
      expect(await h.prisma.payment.count()).toBe(0);

      // Other methods never touch the drawer.
      await pay(s.cashier, made.invoice.id, [{ method: 'UPI', amountPaise: 10000 }]).expect(200);
      await open().expect(201);
      await pay(s.cashier, made.invoice.id, [{ method: 'CASH', amountPaise: 17300 }]).expect(200);
      expect((await current()).expectedCashPaise).toBe(117_300);
    });

    it('needs the permission', async () => {
      const captain = await h.prisma.user.create({
        data: { restaurantId: s.fx.restaurant.id, roleId: s.fx.roles.captain!, name: 'Captain', email: 'captain@test.local', passwordHash: s.fx.cashier.passwordHash },
      });
      const client = h.client();
      await client.loginPos(captain.email, PASSWORD, { terminalId: s.fx.terminal.id });
      expect((await open(client)).status).toBe(403);
      expect((await client.get('/registers/current')).status).toBe(403);
      expect((await client.get('/registers')).status).toBe(403);
    });
  });

  describe('cash in and cash out', () => {
    it('needs a manager, records the reason, and moves what should be in the drawer', async () => {
      await open().expect(201);
      const body = { type: 'CASH_OUT', amountPaise: 20_000, reason: 'Paid the milk supplier' };
      const alone = await s.cashier.post('/registers/current/movements', body);
      expect(alone.status).toBe(403);
      expect(alone.body.code).toBe('APPROVAL_REQUIRED');

      const out = await s.cashier.post('/registers/current/movements', { ...body, approval: s.ownerApproval }).expect(201);
      expect(out.body).toMatchObject({ cashOutPaise: 20_000, expectedCashPaise: 80_000 });
      const put = await s.cashier.post('/registers/current/movements', { type: 'CASH_IN', amountPaise: 5_000, reason: 'Change from the bank', approval: s.ownerApproval }).expect(201);
      expect(put.body).toMatchObject({ cashInPaise: 5_000, cashOutPaise: 20_000, expectedCashPaise: 85_000 });
      expect(put.body.movements).toEqual([
        expect.objectContaining({ type: 'CASH_OUT', amountPaise: 20_000, reason: 'Paid the milk supplier', createdByName: 'Cashier' }),
        expect.objectContaining({ type: 'CASH_IN', amountPaise: 5_000, reason: 'Change from the bank' }),
      ]);
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'register.cash_out' } });
      expect(audit).toMatchObject({ reason: 'Paid the milk supplier', after: { amountPaise: 20_000, approvedBy: s.fx.owner.id } });
    });

    it('refuses more than the drawer holds, a missing reason, a zero amount and a closed register', async () => {
      const path = '/registers/current/movements';
      const noRegister = await s.owner.post(path, { type: 'CASH_IN', amountPaise: 1000, reason: 'Float' });
      expect(noRegister.status).toBe(409);
      expect(noRegister.body.code).toBe('REGISTER_NOT_OPEN');

      await open(s.owner, 10_000).expect(201);
      const tooMuch = await s.owner.post(path, { type: 'CASH_OUT', amountPaise: 10_001, reason: 'Supplier' });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.code).toBe('CASH_OUT_TOO_LARGE');
      expect((await s.owner.post(path, { type: 'CASH_OUT', amountPaise: 1000 })).status).toBe(400);
      expect((await s.owner.post(path, { type: 'CASH_OUT', amountPaise: 0, reason: 'Nothing' })).status).toBe(400);
      expect((await s.owner.post(path, { type: 'SALE', amountPaise: 100, reason: 'Sneaky' })).status).toBe(400);
      await s.owner.post(path, { type: 'CASH_OUT', amountPaise: 10_000, reason: 'Banked' }).expect(201);
    });

    it('keeps cash movements as written: the database refuses to change or delete them', async () => {
      await open(s.owner).expect(201);
      await s.owner.post('/registers/current/movements', { type: 'CASH_IN', amountPaise: 1000, reason: 'Float' }).expect(201);
      await expect(h.prisma.$executeRaw`UPDATE cash_register_transactions SET amount_paise = 1`).rejects.toThrow(/append-only/);
      await expect(h.prisma.$executeRaw`DELETE FROM cash_register_transactions`).rejects.toThrow(/append-only/);
    });
  });

  describe('closing', () => {
    it('compares the count with what should be there and records the difference', async () => {
      const { id } = (await open().expect(201)).body;
      await sale('CASH');
      const closed = await s.cashier.post('/registers/' + id + '/close', {
        countedCashPaise: 127_000, denominations: { 500: 2, 100: 2, 50: 1, 20: 1 }, notes: 'Could not find ₹3',
      });
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({
        status: 'CLOSED', openingCashPaise: 100_000, cashSalesPaise: 27300, expectedCashPaise: 127_300, countedCashPaise: 127_000, variancePaise: -300,
        denominations: { 500: 2, 100: 2, 50: 1, 20: 1 }, closingNotes: 'Could not find ₹3', closedByName: 'Cashier',
      });
      expect(closed.body.closedAt).toEqual(expect.any(String));
      expect((await s.cashier.get('/registers/current').expect(200)).body).toEqual({ register: null });
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'register.closed' } });
      expect(audit.after).toMatchObject({ expectedCashPaise: 127_300, countedCashPaise: 127_000, variancePaise: -300 });

      // Money taken afterwards belongs to no register, and a new one can be opened.
      await sale('CASH');
      expect(await h.prisma.payment.count({ where: { registerSessionId: null } })).toBe(1);
      await open(s.cashier, 127_000).expect(201);
    });

    it('refuses notes and coins that do not add up, an unknown note, and closing twice', async () => {
      const { id } = (await open().expect(201)).body;
      const path = '/registers/' + id + '/close';
      expect((await s.cashier.post(path, { countedCashPaise: 100_000, denominations: { 500: 1 } })).status).toBe(400);
      expect((await s.cashier.post(path, { countedCashPaise: 100_000, denominations: { 1000: 1 } })).status).toBe(400);
      expect((await s.cashier.post(path, { countedCashPaise: -1 })).status).toBe(400);
      expect((await s.cashier.post(path, {})).status).toBe(400);
      await s.cashier.post(path, { countedCashPaise: 100_000 }).expect(200);
      const twice = await s.cashier.post(path, { countedCashPaise: 100_000 });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('REGISTER_CLOSED');
    });

    it('keeps a closed register as it was counted, whatever is corrected afterwards', async () => {
      const { id } = (await open().expect(201)).body;
      const { invoice } = await sale('CASH');
      await s.cashier.post('/registers/' + id + '/close', { countedCashPaise: 127_300 }).expect(200);

      // The owner later finds the guest paid by UPI: the bill changes, the count of that evening does not.
      const payment = await h.prisma.payment.findFirstOrThrow();
      await s.owner.patch('/invoices/' + invoice.id + '/payments/' + payment.id, { method: 'UPI', reason: 'Paid by UPI' }).expect(200);
      const after = (await s.owner.get('/registers/' + id).expect(200)).body;
      expect(after).toMatchObject({ expectedCashPaise: 127_300, countedCashPaise: 127_300, variancePaise: 0, cashSalesPaise: 0 });

      await expect(h.prisma.$executeRaw`UPDATE cash_register_sessions SET counted_cash_paise = 1 WHERE id = ${id}::uuid`).rejects.toThrow(/closed cash register/);
      await expect(h.prisma.$executeRaw`DELETE FROM cash_register_sessions WHERE id = ${id}::uuid`).rejects.toThrow(/cannot be deleted/);
    });

    it('lets a manager close a register someone left open, but not another cashier', async () => {
      const { id } = (await open().expect(201)).body;
      const other = await h.prisma.user.create({
        data: { restaurantId: s.fx.restaurant.id, roleId: s.fx.roles.cashier!, name: 'Second Cashier', email: 'second@test.local', passwordHash: s.fx.cashier.passwordHash },
      });
      const second = h.client();
      await second.loginPos(other.email, PASSWORD, { terminalId: s.fx.terminal.id });
      expect((await second.post('/registers/' + id + '/close', { countedCashPaise: 100_000 })).status).toBe(404);
      expect((await second.get('/registers/' + id)).status).toBe(404);

      const closed = await s.owner.post('/registers/' + id + '/close', { countedCashPaise: 99_000, notes: 'Cashier went home' }).expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', variancePaise: -1000, closedByName: 'Owner', user: { name: 'Cashier' } });
    });
  });

  describe('refunds and corrections', () => {
    it('takes a cash refund out of the register of whoever hands it back, or the register that took the money', async () => {
      const { id } = (await open().expect(201)).body;
      const { invoice } = await sale('CASH');
      const payment = await h.prisma.payment.findFirstOrThrow();
      // The owner has no register open, so the money comes out of the drawer it went into.
      await s.owner.post('/invoices/' + invoice.id + '/refunds', { id: randomUUID(), paymentId: payment.id, amountPaise: 7300, reason: 'Cold food' }).expect(200);
      expect((await h.prisma.refund.findFirstOrThrow()).registerSessionId).toBe(id);
      expect(await current()).toMatchObject({ cashSalesPaise: 27300, cashRefundsPaise: 7300, expectedCashPaise: 120_000 });

      // With a register of their own open, it comes out of theirs.
      const mine = (await open(s.owner, 50_000).expect(201)).body.id;
      await s.owner.post('/invoices/' + invoice.id + '/refunds', { id: randomUUID(), paymentId: payment.id, amountPaise: 5000, reason: 'Cold food again' }).expect(200);
      expect((await h.prisma.refund.findFirstOrThrow({ where: { amountPaise: 5000 } })).registerSessionId).toBe(mine);
      expect((await current(s.owner)).expectedCashPaise).toBe(45_000);
      expect((await current()).expectedCashPaise).toBe(120_000);
    });

    it('follows a bill that is corrected or erased while the register is open', async () => {
      await open().expect(201);
      const first = await sale('CASH');
      const second = await sale('CASH');
      expect((await current()).expectedCashPaise).toBe(154_600);

      // Paid by UPI after all: that cash was never in the drawer.
      const payment = await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: first.invoice.id } });
      await s.owner.patch('/invoices/' + first.invoice.id + '/payments/' + payment.id, { method: 'UPI', reason: 'Paid by UPI' }).expect(200);
      expect((await current()).expectedCashPaise).toBe(127_300);

      // The items change and the payment is kept: it stays in the same register.
      await s.owner.post('/orders/' + second.order.id + '/amend', { items: [line(s.menu.paneer.id, 2)], payment: { method: 'CASH' }, reason: 'Two were served' }).expect(200);
      expect((await current()).expectedCashPaise).toBe(154_600);

      // The owner erases the order: its cash no longer counts.
      await s.owner.post('/orders/' + second.order.id + '/delete', { reason: 'Test bill' }).expect(200);
      expect((await current()).expectedCashPaise).toBe(100_000);
    });
  });

  describe('history', () => {
    it('shows a cashier their own registers and a manager everyone\'s, with filters and sorting', async () => {
      const mine = (await open().expect(201)).body.id;
      await s.cashier.post('/registers/' + mine + '/close', { countedCashPaise: 100_500 }).expect(200);
      const theirs = (await open(s.owner, 20_000).expect(201)).body.id;

      const own = (await s.cashier.get('/registers').expect(200)).body;
      expect(own.items.map((row: { id: string }) => row.id)).toEqual([mine]);
      // Asking for someone else's by id does not get around that.
      expect((await s.cashier.get('/registers?userId=' + s.fx.owner.id).expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([mine]);

      const all = (await s.owner.get('/registers?sort=opening&direction=asc').expect(200)).body;
      expect(all.total).toBe(2);
      expect(all.items.map((row: { id: string }) => row.id)).toEqual([theirs, mine]);
      expect((await s.owner.get('/registers?status=OPEN').expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([theirs]);
      expect((await s.owner.get('/registers?userId=' + s.fx.cashier.id).expect(200)).body.items).toHaveLength(1);
      expect((await s.owner.get('/registers?from=2020-01-01&to=2020-01-31').expect(200)).body.total).toBe(0);
      // Open registers have no variance yet and sort after the closed ones either way.
      expect((await s.owner.get('/registers?sort=variance&direction=desc').expect(200)).body.items.map((row: { id: string }) => row.id)).toEqual([mine, theirs]);
      expect((await s.owner.get('/registers?sort=nonsense')).status).toBe(400);
    });

    it('keeps one restaurant\'s registers out of another\'s sight', async () => {
      const { id } = (await open().expect(201)).body;
      const other = await scene(h, 'b');
      expect((await other.owner.get('/registers').expect(200)).body.total).toBe(0);
      expect((await other.owner.get('/registers/' + id)).status).toBe(404);
      expect((await other.owner.post('/registers/' + id + '/close', { countedCashPaise: 0 })).status).toBe(404);
    });
  });
});

/** Comparing what was recorded with what actually arrived. */
describe('payment reconciliation', () => {
  let h: Harness;
  let s: Scene;
  const range = 'from=' + TODAY + '&to=' + TODAY;

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

  async function sale(method: string, amountPaise = 27300) {
    const made = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
    await pay(s.cashier, made.invoice.id, [{ method, amountPaise }]).expect(200);
    return made;
  }
  const summary = async () => (await s.owner.get('/reconciliation?' + range).expect(200)).body;

  it('adds up each day and method, less refunds, and compares it with the settled amount entered', async () => {
    const { invoice } = await sale('UPI');
    await sale('UPI');
    await sale('CARD');
    const payment = await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    await s.owner.post('/invoices/' + invoice.id + '/refunds', { id: randomUUID(), paymentId: payment.id, amountPaise: 7300, reason: 'Cold food' }).expect(200);

    const before = await summary();
    expect(before.rows).toEqual([
      expect.objectContaining({ businessDate: TODAY, method: 'UPI', count: 2, receivedPaise: 54600, refundedPaise: 7300, netPaise: 47300, settledPaise: null, differencePaise: null, changedSince: false }),
      expect.objectContaining({ businessDate: TODAY, method: 'CARD', count: 1, receivedPaise: 27300, refundedPaise: 0, netPaise: 27300, settledPaise: null }),
    ]);

    const saved = await s.owner.put('/reconciliation', { businessDate: TODAY, method: 'UPI', settledPaise: 47000, note: 'Bank shows one payment short by ₹3' }).expect(200);
    expect(saved.body).toMatchObject({ method: 'UPI', netPaise: 47300, settledPaise: 47000, differencePaise: -300, reconciledByName: 'Owner', note: 'Bank shows one payment short by ₹3', changedSince: false });
    expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.reconciled' } })).after).toMatchObject({ method: 'UPI', recordedPaise: 47300, settledPaise: 47000 });

    // Another UPI payment for the day arrives after the figure was entered: the row says so.
    await sale('UPI');
    const upi = (await summary()).rows.find((row: { method: string }) => row.method === 'UPI');
    expect(upi).toMatchObject({ netPaise: 74600, settledPaise: 47000, differencePaise: -27600, changedSince: true });

    // Entering it again brings it up to date; clearing removes it.
    await s.owner.put('/reconciliation', { businessDate: TODAY, method: 'UPI', settledPaise: 74600 }).expect(200);
    expect((await summary()).rows.find((row: { method: string }) => row.method === 'UPI')).toMatchObject({ differencePaise: 0, changedSince: false, note: null });
    await s.owner.delete('/reconciliation/' + TODAY + '/UPI').expect(204);
    expect((await summary()).rows.find((row: { method: string }) => row.method === 'UPI')).toMatchObject({ settledPaise: null, differencePaise: null });
    expect((await s.owner.delete('/reconciliation/' + TODAY + '/UPI')).status).toBe(404);
  });

  it('shows how much of the cash went through a register', async () => {
    await sale('CASH');
    const { id } = (await s.cashier.post('/registers/open', { openingCashPaise: 50_000 }).expect(201)).body;
    await sale('CASH');
    await sale('CASH');
    await s.cashier.post('/registers/' + id + '/close', { countedCashPaise: 104_000 }).expect(200);
    await s.owner.post('/registers/open', { openingCashPaise: 0 }).expect(201);

    expect((await summary()).cash).toEqual({ inRegistersPaise: 54600, outsideRegistersPaise: 27300, registerVariancePaise: -600, registersClosed: 1, registersOpen: 1 });

    const cash = (await s.owner.get('/payments?' + range + '&method=CASH').expect(200)).body;
    expect(cash.total).toBe(3);
    expect(cash.items.filter((item: { inRegister: boolean }) => item.inRegister)).toHaveLength(2);
    expect(cash.items[0]).toMatchObject({ method: 'CASH', amountPaise: 27300, receivedByName: 'Cashier', businessDate: TODAY, invoiceNumber: expect.stringMatching(/^A1\//) });
    expect((await s.owner.get('/payments?' + range + '&registerSessionId=' + id).expect(200)).body.total).toBe(2);
    expect((await s.owner.get('/payments?' + range + '&method=UPI').expect(200)).body.total).toBe(0);
  });

  it('is for those who may reconcile payments, for days that have happened, within one restaurant', async () => {
    await sale('UPI');
    expect((await s.cashier.get('/reconciliation?' + range)).status).toBe(403);
    expect((await s.cashier.put('/reconciliation', { businessDate: TODAY, method: 'UPI', settledPaise: 1 })).status).toBe(403);
    expect((await s.cashier.get('/payments?' + range)).status).toBe(403);

    expect((await s.owner.put('/reconciliation', { businessDate: '2999-01-01', method: 'UPI', settledPaise: 1 })).body.code).toBe('DATE_IN_FUTURE');
    expect((await s.owner.put('/reconciliation', { businessDate: TODAY, method: 'CHEQUE', settledPaise: 1 })).status).toBe(400);
    expect((await s.owner.put('/reconciliation', { businessDate: TODAY, method: 'UPI', settledPaise: -1 })).status).toBe(400);
    expect((await s.owner.get('/reconciliation?from=' + TODAY + '&to=2020-01-01')).status).toBe(400);
    expect((await s.owner.get('/reconciliation?from=2020-01-01&to=' + TODAY)).status).toBe(400);
    expect((await s.owner.delete('/reconciliation/not-a-date/UPI')).status).toBe(422);

    await s.owner.put('/reconciliation', { businessDate: TODAY, method: 'UPI', settledPaise: 27300 }).expect(200);
    const other = await scene(h, 'b');
    const theirs = (await other.owner.get('/reconciliation?' + range).expect(200)).body;
    expect(theirs.rows).toEqual([]);
    expect((await other.owner.get('/payments?' + range).expect(200)).body.total).toBe(0);
    expect((await other.owner.delete('/reconciliation/' + TODAY + '/UPI')).status).toBe(404);
  });
});
