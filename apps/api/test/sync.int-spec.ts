import { randomUUID } from 'node:crypto';
import { businessDateOf, computeBill, formatDocumentNumber } from '@pos/billing-core';
import { FY, scene, type Scene } from './support/billing.js';
import { createHarness, type Harness } from './support/harness.js';

/**
 * Billing offline, step 2: the server takes in what a device did while the internet was down. Each operation is
 * applied once, in the device's order; bills are kept exactly as printed, in the device's own series, and whatever
 * does not add up is kept and flagged for the owner rather than refused.
 */
describe('Uploading offline work', () => {
  let h: Harness;
  let s: Scene;
  let deviceKey: string;
  let code: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    s = await scene(h);
    deviceKey = randomUUID();
    const device = (await s.cashier.post('/pos/devices', { deviceKey, label: 'Counter tablet' }).expect(200)).body;
    code = device.offlineCode;
    expect(device.numbers).toMatchObject({ offlineCode: code, financialYear: FY, nextInvoiceNumber: 1, nextOrderNumber: 1 });
  });
  afterAll(async () => {
    await h.close();
  });

  const today = () => businessDateOf(new Date());
  const push = (operations: object[], client = s.cashier, key = deviceKey) => client.post('/sync/push', { deviceKey: key, pending: 0, operations });
  const outcomes = (body: { results: { outcome: string }[] }) => body.results.map((result) => result.outcome);
  const flagCodes = (body: { results: { flags: { code: string }[] }[] }) => body.results.flatMap((result) => result.flags.map((flag) => flag.code));

  interface Line { productId: string; name: string; unitPricePaise: number; gstRateBps: number; taxGroupId: string | null; quantity: number; discount?: { type: 'PERCENT' | 'AMOUNT'; value: number } | null }
  const paneer = (quantity = 2, extra: Partial<Line> = {}): Line => ({
    productId: s.menu.paneer.id, name: 'Paneer Tikka', unitPricePaise: 26000, gstRateBps: 500, taxGroupId: s.fx.taxGroup.id, quantity, ...extra,
  });
  const cola = (quantity = 1): Line => ({ productId: s.menu.cola.id, name: 'Cola', unitPricePaise: 5000, gstRateBps: 1800, taxGroupId: s.menu.gst18.id, quantity });

  /**
   * One sale made on the device offline, as its outbox would hold it: the order, its kitchen ticket, the bill as
   * printed (worked out with the same bill engine the device uses) and the cash taken.
   */
  function sale(number: number, lines: Line[] = [paneer()], options: { orderNumber?: number; discount?: { type: 'PERCENT' | 'AMOUNT'; value: number } | null; userId?: string; registerSessionId?: string | null } = {}) {
    const at = new Date().toISOString();
    const businessDate = today();
    const userId = options.userId ?? s.fx.cashier.id;
    const orderId = randomUUID();
    const invoiceId = randomUUID();
    const items = lines.map((l) => ({
      id: randomUUID(), productId: l.productId, variantId: null, modifiers: [], name: l.name, variantName: null, hsnSac: null, taxGroupId: l.taxGroupId,
      gstRateBps: l.gstRateBps, cessRateBps: 0, priceIncludesTax: false, stationId: s.fx.station.id, unitPricePaise: l.unitPricePaise,
      quantity: l.quantity, kotQuantity: l.quantity, notes: null, discount: l.discount ?? null,
    }));
    const bill = computeBill({
      lines: items.map((item) => ({ id: item.id, quantity: item.quantity, unitPricePaise: item.unitPricePaise, priceIncludesTax: false, tax: { gstRateBps: item.gstRateBps, cessRateBps: 0 }, discount: item.discount })),
      discount: options.discount ?? null, taxApplicable: true, interState: false, serviceChargeBps: 0, serviceChargeTax: { gstRateBps: 500, cessRateBps: 0 }, roundOff: 'NEAREST_RUPEE',
    });
    const op = <T extends string, B extends object>(type: T, body: B) => ({ id: randomUUID(), type, userId, createdAt: at, ...body });
    const orderOp = op('order.save', {
      order: {
        id: orderId, type: 'TAKEAWAY', orderNumber: options.orderNumber ?? number, businessDate, guests: 1, notes: null, deliveryAddress: null,
        customer: { phone: '9876543210', name: 'Asha', address: null }, items, discount: options.discount ?? null,
      },
    });
    const kotOp = op('kot.print', {
      kot: {
        id: randomUUID(), orderId, stationId: s.fx.station.id, type: 'NEW', printedNumber: `${code}-${number}/1`, businessDate, notes: null,
        items: items.map((item) => ({ orderItemId: item.id, name: item.name, quantity: item.quantity, notes: null })),
      },
    });
    const invoiceOp = op('invoice.issue', {
      invoice: {
        id: invoiceId, orderId, number, invoiceNumber: formatDocumentNumber(code, FY, number), businessDate, issuedAt: at, docType: 'TAX_INVOICE',
        seller: { name: 'Test Restaurant A', legalName: null, gstin: '27AAAAA0000A1Z5', fssaiNumber: null, phone: null, addressLines: [], stateCode: '27', stateName: 'Maharashtra', footer: null, upiVpa: null },
        customer: { name: 'Asha', phone: '9876543210', address: null }, serviceChargeBps: 0, printCount: 1,
        grossPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxablePaise: bill.taxablePaise, cgstPaise: bill.cgstPaise, sgstPaise: bill.sgstPaise,
        igstPaise: bill.igstPaise, cessPaise: bill.cessPaise, serviceChargePaise: bill.serviceChargePaise, roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise,
        items: bill.lines.map((line, index) => ({
          orderItemId: line.id, name: items[index]!.name, hsnSac: null, quantity: line.quantity, unitPricePaise: line.unitPricePaise, priceIncludesTax: false,
          grossPaise: line.grossPaise, discountPaise: line.discountPaise, taxablePaise: line.taxablePaise, taxRateBps: line.gstRateBps, cessRateBps: 0,
          cgstPaise: line.cgstPaise, sgstPaise: line.sgstPaise, igstPaise: line.igstPaise, cessPaise: line.cessPaise, totalPaise: line.totalPaise,
        })),
        taxes: bill.taxSummary,
      },
    });
    const paymentOp = op('payment.record', {
      payment: {
        id: randomUUID(), invoiceId, method: 'CASH', amountPaise: bill.totalPaise, tenderedPaise: null, reference: null, paidAt: at, businessDate,
        registerSessionId: options.registerSessionId ?? null,
      },
    });
    return { orderId, invoiceId, total: bill.totalPaise, ops: [orderOp, kotOp, invoiceOp, paymentOp], orderOp, kotOp, invoiceOp, paymentOp };
  }

  describe('a sale made offline', () => {
    it('is stored as printed: the order, its kitchen ticket, the bill in the device\'s series, and the cash taken', async () => {
      const one = sale(1, [paneer(2), cola(1)]);
      const pushed = (await push(one.ops).expect(200)).body;
      expect(outcomes(pushed)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
      expect(flagCodes(pushed)).toEqual([]);
      expect(pushed.numbers).toMatchObject({ offlineCode: code, nextInvoiceNumber: 2, nextOrderNumber: 2 });

      const order = await h.prisma.order.findUniqueOrThrow({ where: { id: one.orderId }, include: { terminal: true, customer: true, items: true } });
      expect(order).toMatchObject({ series: code, orderNumber: 1, tokenNumber: 1, status: 'SETTLED', createdById: s.fx.cashier.id, totalPaise: one.total });
      expect(order.terminal?.kind).toBe('OFFLINE');
      expect(order.customer?.phone).toBe('9876543210');
      expect(order.items.map((item) => item.kotQuantity)).toEqual([2, 1]);

      const kot = await h.prisma.kot.findFirstOrThrow({ where: { orderId: one.orderId } });
      expect(kot).toMatchObject({ status: 'COMPLETED', kotNumber: 1, offlineNumber: `${code}-1/1`, printCount: 1 });

      // The bill reads as any other, under the number printed.
      const invoice = (await s.owner.get(`/invoices/${one.invoiceId}`).expect(200)).body;
      expect(invoice).toMatchObject({ invoiceNumber: `${code}/${FY}/000001`, totalPaise: one.total, paidPaise: one.total, paymentStatus: 'PAID' });
      expect(invoice.items).toHaveLength(2);
      const payment = await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: one.invoiceId } });
      expect(payment).toMatchObject({ method: 'CASH', amountPaise: one.total, receivedById: s.fx.cashier.id, status: 'SUCCESS' });

      // Recorded as done offline, by the cashier, on this device.
      const issued = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'invoice.issued', entityId: one.invoiceId } });
      expect(issued.userId).toBe(s.fx.cashier.id);
      expect(issued.after).toMatchObject({ offline: true, device: code });
      // Nothing to check: the review list is empty.
      expect((await s.owner.get('/sync/reviews').expect(200)).body.total).toBe(0);
    });

    it('is applied once: the same batch again, or two uploads of it at once, changes nothing', async () => {
      const one = sale(1);
      await push(one.ops).expect(200);
      const again = (await push(one.ops).expect(200)).body;
      expect(outcomes(again)).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);

      const two = sale(2);
      const both = await Promise.all([push(two.ops), push(two.ops)]);
      expect(both.map((response) => response.status)).toEqual([200, 200]);
      expect([...outcomes(both[0]!.body), ...outcomes(both[1]!.body)].sort()).toEqual([...Array(4).fill('APPLIED'), ...Array(4).fill('DUPLICATE')].sort());

      expect(await h.prisma.invoice.count()).toBe(2);
      expect(await h.prisma.payment.count()).toBe(2);
      expect(await h.prisma.kot.count()).toBe(2);
      const paid = await h.prisma.invoice.findUniqueOrThrow({ where: { id: two.invoiceId } });
      expect(paid.paidPaise).toBe(two.total);
      // A payment recorded online with the same id, before its offline copy arrived, is not counted twice either.
      expect(await h.prisma.syncOperation.count()).toBe(8);
    });

    it('waits for what an operation needs: a bill before its order waits, and so does everything after it', async () => {
      const one = sale(1);
      const early = (await push([one.invoiceOp, one.paymentOp]).expect(200)).body;
      expect(early.results).toMatchObject([{ outcome: 'DEFERRED', code: 'WAITING' }, { outcome: 'DEFERRED', code: 'WAITING' }]);
      expect(await h.prisma.invoice.count()).toBe(0);
      expect(await h.prisma.syncOperation.count()).toBe(0);

      expect(outcomes((await push([one.orderOp, one.kotOp]).expect(200)).body)).toEqual(['APPLIED', 'APPLIED']);
      expect(outcomes((await push([one.invoiceOp, one.paymentOp]).expect(200)).body)).toEqual(['APPLIED', 'APPLIED']);
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: one.orderId } })).status).toBe('SETTLED');
    });

    it('can be changed while unbilled: the order sent again replaces its lines', async () => {
      const one = sale(1, [paneer(1)]);
      await push([one.orderOp]).expect(200);
      const changed = structuredClone(one.orderOp);
      changed.id = randomUUID();
      changed.order.items[0]!.quantity = 3;
      changed.order.items.push({ ...structuredClone(changed.order.items[0]!), id: randomUUID(), productId: s.menu.cola.id, name: 'Cola', unitPricePaise: 5000, gstRateBps: 1800, taxGroupId: s.menu.gst18.id, quantity: 1, kotQuantity: 0 });
      expect(outcomes((await push([changed]).expect(200)).body)).toEqual(['APPLIED']);
      const order = await h.prisma.order.findUniqueOrThrow({ where: { id: one.orderId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
      expect(order.items.map((item) => [item.name, item.quantity])).toEqual([['Paneer Tikka', 3], ['Cola', 1]]);
      expect(order.orderNumber).toBe(1);
      // Billed online now, the order is billed in the counter's series, not the device's.
      const [bill] = (await s.cashier.post(`/orders/${one.orderId}/invoices`, {}).expect(201)).body;
      expect(bill.invoiceNumber).toBe(`A1/${FY}/000001`);
      // A change from the device after that is refused, and kept for the owner.
      const late = structuredClone(changed);
      late.id = randomUUID();
      expect((await push([late]).expect(200)).body.results).toMatchObject([{ outcome: 'REJECTED', code: 'ORDER_CLOSED' }]);
    });
  });

  describe('what does not add up is kept, and flagged', () => {
    it('a bill whose printed amounts do not work out from its lines', async () => {
      const one = sale(1);
      one.invoiceOp.invoice.totalPaise += 1000;
      const pushed = (await push(one.ops).expect(200)).body;
      expect(outcomes(pushed)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
      expect(pushed.results[2].flags).toMatchObject([{ code: 'TOTALS_DIFFER', message: expect.stringContaining('total ₹') }]);
      // Kept as printed: the guest's copy is the record.
      expect((await h.prisma.invoice.findUniqueOrThrow({ where: { id: one.invoiceId } })).totalPaise).toBe(one.total + 1000);
      // The cash taken was the original total, so the bill is part paid, and the order not settled.
      expect((await h.prisma.invoice.findUniqueOrThrow({ where: { id: one.invoiceId } })).paymentStatus).toBe('PARTIALLY_PAID');

      const reviews = (await s.owner.get('/sync/reviews').expect(200)).body;
      expect(reviews.total).toBe(1);
      expect(reviews.items[0]).toMatchObject({
        type: 'invoice.issue', status: 'APPLIED', deviceCode: code, deviceLabel: 'Counter tablet', userName: 'Cashier', uploadedByName: 'Cashier',
        invoiceId: one.invoiceId, summary: expect.stringContaining(`Bill ${code}/${FY}/000001`), reviewedAt: null,
      });
    });

    it('a skipped bill number, and a number used twice, which is stored under the next free one', async () => {
      await push(sale(1).ops).expect(200);
      const skipped = (await push(sale(3).ops).expect(200)).body;
      expect(skipped.results[2].flags).toMatchObject([{ code: 'NUMBER_GAP', message: expect.stringContaining(`${code}/${FY}/000002`) }]);

      const reused = sale(1, [paneer(1)], { orderNumber: 4 });
      const pushed = (await push(reused.ops).expect(200)).body;
      expect(pushed.results[2].flags).toMatchObject([{ code: 'DUPLICATE_NUMBER' }]);
      expect((await h.prisma.invoice.findUniqueOrThrow({ where: { id: reused.invoiceId } })).invoiceNumber).toBe(`${code}/${FY}/000004`);
      expect(pushed.numbers.nextInvoiceNumber).toBe(5);

      // An order number already used is renumbered, and said so.
      const clash = sale(5, [paneer(1)], { orderNumber: 1 });
      const order = (await push(clash.ops).expect(200)).body;
      expect(order.results[0].flags).toMatchObject([{ code: 'ORDER_NUMBER_TAKEN' }]);
      expect((await h.prisma.order.findUniqueOrThrow({ where: { id: clash.orderId } })).orderNumber).toBe(5);
    });

    it('a discount over the limit, a price unlike the menu, cash for a closed register, and more paid than was due', async () => {
      // 20% off is over the 10% a cashier may give, and the paneer was charged ₹10 less than the menu says.
      const cheap = sale(1, [paneer(1, { unitPricePaise: 25000 })], { discount: { type: 'PERCENT', value: 2000 } });
      const register = (await s.cashier.post('/registers/open', { openingCashPaise: 0 }).expect(201)).body;
      // Closed online while the device still held the cash it took into it.
      await s.cashier.post(`/registers/${register.id}/close`, { countedCashPaise: 0 }).expect(200);
      cheap.paymentOp.payment.registerSessionId = register.id;
      const pushed = (await push(cheap.ops).expect(200)).body;
      expect(outcomes(pushed)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
      expect(pushed.results[0].flags.map((flag: { code: string }) => flag.code).sort()).toEqual(['DISCOUNT_ABOVE_LIMIT', 'PRICE_DIFFERS']);
      expect(pushed.results[3].flags).toMatchObject([{ code: 'REGISTER_CLOSED' }]);
      expect((await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: cheap.invoiceId } })).registerSessionId).toBeNull();

      // The same bill paid again on the device: the money was taken, so it is kept.
      const twice = { ...structuredClone(cheap.paymentOp), id: randomUUID() };
      twice.payment.id = randomUUID();
      twice.payment.registerSessionId = null;
      const over = (await push([twice]).expect(200)).body;
      expect(over.results[0]).toMatchObject({ outcome: 'APPLIED', flags: [{ code: 'OVERPAID' }] });
      expect((await h.prisma.invoice.findUniqueOrThrow({ where: { id: cheap.invoiceId } })).paidPaise).toBe(cheap.total * 2);
    });

    it('cash taken into the register that is still open counts in it', async () => {
      const register = (await s.cashier.post('/registers/open', { openingCashPaise: 50000 }).expect(201)).body;
      const one = sale(1, [paneer(1)], { registerSessionId: register.id });
      expect(flagCodes((await push(one.ops).expect(200)).body)).toEqual([]);
      const current = (await s.cashier.get(`/registers/${register.id}`).expect(200)).body;
      expect(current.expectedCashPaise).toBe(50000 + one.total);
    });

    it('a clock far ahead, and work done by someone not allowed to bill', async () => {
      const chef = await h.prisma.user.create({ data: { restaurantId: s.fx.restaurant.id, roleId: s.fx.roles.kitchen!, name: 'Chef', email: 'chef@test.local', passwordHash: 'x' } });
      const one = sale(1, [paneer(1)], { userId: chef.id });
      const ahead = new Date(Date.now() + 2 * 3_600_000).toISOString();
      for (const op of one.ops) op.createdAt = ahead;
      const pushed = (await push(one.ops).expect(200)).body;
      expect(outcomes(pushed)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
      expect(pushed.results[2].flags.map((flag: { code: string }) => flag.code)).toEqual(expect.arrayContaining(['CLOCK_AHEAD', 'NOT_ALLOWED']));
    });
  });

  describe('what can never apply', () => {
    it('is refused and kept for the owner, along with whatever depended on it, while the rest of the batch goes on', async () => {
      const other = await scene(h, 'b');
      const bad = sale(1);
      bad.orderOp.order.items[0]!.productId = other.menu.paneer.id;
      const good = sale(2);
      const unreadable = { id: randomUUID(), type: 'invoice.issue', userId: s.fx.cashier.id, createdAt: new Date().toISOString(), invoice: { id: 'nonsense' } };
      const pushed = (await push([bad.orderOp, unreadable, ...good.ops, bad.invoiceOp]).expect(200)).body;
      expect(pushed.results.map((r: { outcome: string; code: string | null }) => `${r.outcome}:${r.code ?? ''}`)).toEqual([
        'REJECTED:UNKNOWN_ITEM', 'REJECTED:INVALID_OPERATION', 'APPLIED:', 'APPLIED:', 'APPLIED:', 'APPLIED:', 'REJECTED:DEPENDS_ON_REJECTED',
      ]);
      expect(await h.prisma.order.count({ where: { id: bad.orderId } })).toBe(0);
      expect(await h.prisma.syncOperation.count({ where: { status: 'REJECTED' } })).toBe(3);
      const reviews = (await s.owner.get('/sync/reviews').expect(200)).body;
      expect(reviews.items.map((item: { status: string }) => item.status).sort()).toEqual(['APPLIED', 'REJECTED', 'REJECTED', 'REJECTED']);
      expect(reviews.items.find((item: { type: string; status: string }) => item.type === 'order.save' && item.status === 'REJECTED').error).toContain('is not on this restaurant\'s menu');
      // The good bill is number 2, and number 1 was the refused one: the owner is told it never arrived.
      expect(reviews.items.find((item: { status: string }) => item.status === 'APPLIED').flags).toMatchObject([{ code: 'NUMBER_GAP' }]);
    });

    it('never crosses restaurants: another restaurant\'s operation id, device or user', async () => {
      const other = await scene(h, 'b');
      const theirKey = randomUUID();
      await other.cashier.post('/pos/devices', { deviceKey: theirKey, label: null }).expect(200);
      const theirs = sale(1, [paneer(1)]);
      theirs.orderOp.order.items[0]!.productId = other.menu.paneer.id;
      theirs.orderOp.order.items[0]!.taxGroupId = other.fx.taxGroup.id;
      theirs.orderOp.order.items[0]!.stationId = other.fx.station.id;
      theirs.orderOp.userId = other.fx.cashier.id;
      expect(outcomes((await push([theirs.orderOp], other.cashier, theirKey).expect(200)).body)).toEqual(['APPLIED']);

      // The same operation id from this restaurant is refused, and theirs is untouched.
      const mine = sale(1);
      const reused = { ...mine.orderOp, id: theirs.orderOp.id };
      expect((await push([reused]).expect(200)).body.results).toMatchObject([{ outcome: 'REJECTED', code: 'OPERATION_ID_TAKEN' }]);
      expect((await h.prisma.syncOperation.findUniqueOrThrow({ where: { id: theirs.orderOp.id } })).restaurantId).toBe(other.fx.restaurant.id);
      // Their device key is not this restaurant's device, and their cashier is not this restaurant's user.
      expect((await push(mine.ops, s.cashier, theirKey)).body.code).toBe('DEVICE_NOT_REGISTERED');
      const stranger = sale(2);
      stranger.orderOp.userId = other.fx.cashier.id;
      expect((await push([stranger.orderOp]).expect(200)).body.results).toMatchObject([{ outcome: 'REJECTED', code: 'UNKNOWN_USER' }]);
      // Nor can a device upload work into another restaurant's order.
      const intruder = sale(3);
      intruder.kotOp.kot.orderId = theirs.orderId;
      expect((await push([intruder.kotOp]).expect(200)).body.results).toMatchObject([{ outcome: 'DEFERRED', code: 'WAITING' }]);
      expect(await h.prisma.kot.count()).toBe(0);
    });
  });

  it('still takes uploads after the trial or paid period has ended, when nothing else can be changed', async () => {
    await h.prisma.restaurant.update({ where: { id: s.fx.restaurant.id }, data: { trialEndsAt: new Date(Date.now() - 86_400_000), paidUntil: null } });
    await h.redis.del(`auth:access:${s.fx.restaurant.id}`);
    const refused = await s.cashier.put(`/orders/${randomUUID()}`, { type: 'TAKEAWAY', items: [] });
    expect(refused.body.code).toBe('SUBSCRIPTION_EXPIRED');
    expect(outcomes((await push(sale(1).ops).expect(200)).body)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
  });

  it('never renumbers the device\'s orders or bills when the owner resets numbers', async () => {
    await s.owner.patch('/settings', { orderRenumberMode: 'AUTO' }).expect(200);
    await push(sale(1).ops).expect(200);
    await push(sale(3, [paneer(1)], { orderNumber: 3 }).ops).expect(200);
    await s.owner.post('/orders/renumber').expect(200);
    const numbers = async () => (await h.prisma.order.findMany({ where: { series: code }, orderBy: { orderNumber: 'asc' } })).map((order) => order.orderNumber);
    expect(await numbers()).toEqual([1, 3]);
  });

  describe('the review list', () => {
    it('is for those who reconcile payments; an item checked moves to the checked list', async () => {
      const one = sale(1);
      one.invoiceOp.invoice.totalPaise += 100;
      await push(one.ops).expect(200);
      expect((await s.cashier.get('/sync/reviews')).status).toBe(403);
      const open = (await s.owner.get('/sync/reviews?status=open').expect(200)).body;
      expect(open.total).toBe(1);
      const checked = (await s.owner.post(`/sync/reviews/${open.items[0].id}/check`, { note: 'Typed over on the device; guest paid the printed amount' }).expect(200)).body;
      expect(checked).toMatchObject({ reviewedByName: 'Owner', reviewedAt: expect.any(String) });
      expect((await s.owner.get('/sync/reviews?status=open').expect(200)).body.total).toBe(0);
      expect((await s.owner.get('/sync/reviews?status=checked').expect(200)).body.total).toBe(1);
      expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'sync.checked' } })).reason).toContain('guest paid the printed amount');
      // Something with nothing to check cannot be marked.
      const clean = (await h.prisma.syncOperation.findMany({ where: { type: 'order.save' } })).find((row) => row.flags === null)!;
      expect((await s.owner.post(`/sync/reviews/${clean.id}/check`, {})).status).toBe(404);
    });
  });
});
