import { randomUUID } from 'node:crypto';
import { billed, FY, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness } from './support/harness.js';

describe('invoices, payments and refunds', () => {
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

  describe('issuing a bill', () => {
    it('issues a numbered tax invoice with a snapshot of seller, items and tax', async () => {
      const { order, invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)], {
        customer: { name: 'Asha Rao', phone: '9876543210' },
      });
      expect(invoice).toMatchObject({
        invoiceNumber: `A1/${FY}/000001`, docType: 'TAX_INVOICE', status: 'ISSUED', paymentStatus: 'UNPAID',
        orderDisplayNumber: 'A1-1', placeOfSupply: '27', placeOfSupplyName: 'Maharashtra', isInterState: false,
        grossPaise: 57000, taxablePaise: 57000, cgstPaise: 1750, sgstPaise: 1750, igstPaise: 0, taxAddedPaise: 3500,
        roundOffPaise: 0, totalPaise: 60500, paidPaise: 0, cashierName: 'Cashier',
        amountInWords: 'Rupees Six Hundred Five Only',
        customer: { name: 'Asha Rao', phone: '9876543210' },
        seller: { name: 'Test Restaurant A', gstin: '27AAAAA0000A1Z5', stateCode: '27' },
      });
      expect(invoice.items.map((i: { name: string; hsnSac: string | null; taxRateBps: number; totalPaise: number }) => [i.name, i.hsnSac, i.taxRateBps, i.totalPaise]))
        .toEqual([['Paneer Tikka', '996331', 500, 54600], ['Cola', null, 1800, 5900]]);
      expect(invoice.taxes).toEqual([
        { type: 'CGST', rateBps: 250, taxablePaise: 52000, amountPaise: 1300 },
        { type: 'CGST', rateBps: 900, taxablePaise: 5000, amountPaise: 450 },
        { type: 'SGST', rateBps: 250, taxablePaise: 52000, amountPaise: 1300 },
        { type: 'SGST', rateBps: 900, taxablePaise: 5000, amountPaise: 450 },
      ]);
      expect((await s.cashier.get(`/orders/${order.id}`)).body).toMatchObject({ status: 'BILLED', invoices: [{ invoiceNumber: invoice.invoiceNumber }] });
    });

    it('locks the order once billed', async () => {
      const { order } = await billed(s.cashier, [line(s.menu.paneer.id)]);
      expect((await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }, order.id)).body.code).toBe('ORDER_LOCKED');
      expect((await s.cashier.post(`/orders/${order.id}/invoices`, {})).body.code).toBe('ORDER_LOCKED');
      expect((await s.cashier.post(`/orders/${order.id}/hold`)).body.code).toBe('ORDER_LOCKED');
      const empty = (await saveOrder(s.cashier, { items: [] })).body;
      expect((await s.cashier.post(`/orders/${empty.id}/invoices`, {})).body.code).toBe('ORDER_EMPTY');
    });

    it('names variants and modifiers on the invoice line', async () => {
      const { invoice } = await billed(s.cashier, [
        line(s.menu.chicken.id, 1, { variantId: s.menu.half.id }),
        line(s.menu.biryani.id, 1, { modifierIds: [s.menu.mild.id, s.menu.egg.id] }),
      ]);
      const names = invoice.items.map((i: { name: string }) => i.name);
      expect(names[0]).toBe('Tandoori Chicken (Half)');
      expect(names[1]).toMatch(/^Veg Biryani \+ /);
      expect(names[1]).toContain('Boiled Egg');
      expect(names[1]).toContain('Mild');
    });

    it('returns the same bill when billing is asked for again with the same bill ids', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }).expect(200)).body;
      const ids = [randomUUID()];
      const first = (await s.cashier.post(`/orders/${order.id}/invoices`, { invoiceIds: ids }).expect(201)).body;
      expect(first.map((invoice: { id: string }) => invoice.id)).toEqual(ids);
      // The answer was lost and the till asks again: the same bill comes back, nothing new is issued.
      const again = (await s.cashier.post(`/orders/${order.id}/invoices`, { invoiceIds: ids }).expect(201)).body;
      expect(again.map((invoice: { id: string; invoiceNumber: string }) => [invoice.id, invoice.invoiceNumber])).toEqual([[ids[0], first[0].invoiceNumber]]);
      expect(await h.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
      expect(await h.prisma.auditLog.count({ where: { action: 'invoice.issued' } })).toBe(1);
      // Other ids still find the order billed.
      expect((await s.cashier.post(`/orders/${order.id}/invoices`, { invoiceIds: [randomUUID()] })).body.code).toBe('ORDER_LOCKED');
    });

    it('issues one bill when the same request arrives twice at once, and keeps split bills under their own ids', async () => {
      for (let round = 0; round < 4; round += 1) {
        const order = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }).expect(200)).body;
        const body = { invoiceIds: [randomUUID()] };
        const results = await Promise.all([s.cashier.post(`/orders/${order.id}/invoices`, body), s.cashier.post(`/orders/${order.id}/invoices`, body)]);
        expect(results.map((r) => r.status)).toEqual([201, 201]);
        expect(results.map((r) => r.body[0].id)).toEqual([body.invoiceIds[0], body.invoiceIds[0]]);
        expect(await h.prisma.invoice.count({ where: { orderId: order.id } })).toBe(1);
      }
      const paneer = line(s.menu.paneer.id);
      const cola = line(s.menu.cola.id);
      const split = (await saveOrder(s.cashier, { items: [paneer, cola] }).expect(200)).body;
      const ids = [randomUUID(), randomUUID()];
      const parts = [[{ orderItemId: paneer.id, quantity: 1 }], [{ orderItemId: cola.id, quantity: 1 }]];
      const bills = (await s.cashier.post(`/orders/${split.id}/invoices`, { parts, invoiceIds: ids }).expect(201)).body;
      expect(bills.map((invoice: { id: string }) => invoice.id)).toEqual(ids);
      expect((await s.cashier.post(`/orders/${split.id}/invoices`, { parts, invoiceIds: ids }).expect(201)).body.map((invoice: { id: string }) => invoice.id)).toEqual(ids);
    });

    it('refuses bill ids that do not match the parts, repeat, or belong to another order', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }).expect(200)).body;
      expect((await s.cashier.post(`/orders/${order.id}/invoices`, { invoiceIds: [randomUUID(), randomUUID()] })).status).toBe(400);
      const same = randomUUID();
      const paneer = line(s.menu.paneer.id);
      const cola = line(s.menu.cola.id);
      const split = (await saveOrder(s.cashier, { items: [paneer, cola] }).expect(200)).body;
      const parts = [[{ orderItemId: paneer.id, quantity: 1 }], [{ orderItemId: cola.id, quantity: 1 }]];
      expect((await s.cashier.post(`/orders/${split.id}/invoices`, { parts, invoiceIds: [same, same] })).status).toBe(400);
      // A bill id already used for one order cannot bill another.
      const taken = randomUUID();
      await s.cashier.post(`/orders/${order.id}/invoices`, { invoiceIds: [taken] }).expect(201);
      const other = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }).expect(200)).body;
      const refused = await s.cashier.post(`/orders/${other.id}/invoices`, { invoiceIds: [taken] });
      expect([refused.status, refused.body.code]).toEqual([409, 'INVOICE_ID_TAKEN']);
      expect(await h.prisma.invoice.count({ where: { orderId: other.id } })).toBe(0);
      // Another restaurant cannot read a bill back through a guessed id.
      const elsewhere = await scene(h, 'b');
      const theirs = (await saveOrder(elsewhere.cashier, { items: [line(elsewhere.menu.cola.id)] }).expect(200)).body;
      expect((await elsewhere.cashier.post(`/orders/${theirs.id}/invoices`, { invoiceIds: [taken] })).body.code).toBe('INVOICE_ID_TAKEN');
    });

    it('issues consecutive numbers with no gaps or repeats when bills are raised together', async () => {
      const orders = [];
      for (let i = 0; i < 6; i += 1) orders.push((await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })).body);
      const responses = await Promise.all(orders.map((order) => s.cashier.post(`/orders/${order.id}/invoices`, {})));
      expect(responses.every((r) => r.status === 201)).toBe(true);
      expect(responses.map((r) => r.body[0].invoiceNumber).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `A1/${FY}/00000${n}`));
    });

    it('gives each terminal its own invoice series', async () => {
      const second = await h.prisma.terminal.create({ data: { restaurantId: s.fx.restaurant.id, code: 'B2', name: 'Counter 2' } });
      const other = h.client();
      await other.login(s.fx.cashier.email, undefined, { client: 'pos', terminalId: second.id });
      await billed(s.cashier, [line(s.menu.cola.id)]);
      const { order, invoice } = await billed(other, [line(s.menu.cola.id)]);
      expect(order.displayNumber).toBe('B2-1');
      expect(invoice.invoiceNumber).toBe(`B2/${FY}/000001`);
    });

    it('extracts tax from prices that include it, so the customer pays the menu price', async () => {
      await s.owner.patch('/settings', { pricesIncludeTax: true }).expect(200);
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      // ₹260 inclusive at 5%: taxable 247.62, CGST 6.19, SGST 6.19.
      expect(invoice).toMatchObject({ grossPaise: 26000, taxablePaise: 24762, cgstPaise: 619, sgstPaise: 619, taxAddedPaise: 0, totalPaise: 26000 });
    });

    it('issues a bill of supply with no tax for an unregistered restaurant', async () => {
      await s.owner.patch('/settings', { gstRegistration: 'UNREGISTERED' }).expect(200);
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1), line(s.menu.cola.id, 1)]);
      expect(invoice).toMatchObject({ docType: 'BILL_OF_SUPPLY', cgstPaise: 0, sgstPaise: 0, taxes: [], totalPaise: 31000 });
    });

    it('charges IGST when the place of supply is another state', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1)] })).body;
      const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, { placeOfSupply: '29' }).expect(201)).body;
      expect(invoice).toMatchObject({ placeOfSupplyName: 'Karnataka', isInterState: true, cgstPaise: 0, sgstPaise: 0, igstPaise: 1300, totalPaise: 27300 });
      expect(invoice.taxes).toEqual([{ type: 'IGST', rateBps: 500, taxablePaise: 26000, amountPaise: 1300 }]);
    });

    it('adds an optional service charge and taxes it when enabled', async () => {
      await s.owner.patch('/settings', { serviceChargeEnabled: true, serviceChargeBps: 1000 }).expect(200);
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      // Food 260 + GST 13; service charge 26 + GST 1.30; total 300.30 → 300.
      expect(invoice).toMatchObject({ serviceChargePaise: 2600, taxablePaise: 28600, cgstPaise: 715, sgstPaise: 715, roundOffPaise: -30, totalPaise: 30000 });
    });

    it('settles a fully discounted bill straight away', async () => {
      const { order, invoice } = await billed(s.owner, [line(s.menu.paneer.id, 1, { discount: { type: 'PERCENT', value: 10000, reason: 'On the house' } })]);
      expect(invoice).toMatchObject({ totalPaise: 0, paymentStatus: 'PAID' });
      expect((await s.owner.get(`/orders/${order.id}`)).body.status).toBe('SETTLED');
    });

    it('keeps the invoice as issued even when the menu and tax rates change afterwards', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      await s.owner.patch(`/products/${s.menu.paneer.id}`, { name: 'Renamed', basePricePaise: 99900 }).expect(200);
      await s.owner.patch(`/tax-groups/${s.fx.taxGroup.id}`, { gstRateBps: 1800 }).expect(200);
      await s.owner.patch('/restaurant', { name: 'New Name' }).expect(200);
      const again = (await s.cashier.get(`/invoices/${invoice.id}`).expect(200)).body;
      expect(again).toMatchObject({ totalPaise: 27300, cgstPaise: 650, seller: { name: 'Test Restaurant A' } });
      expect(again.items[0]).toMatchObject({ name: 'Paneer Tikka', unitPricePaise: 26000, taxRateBps: 500 });
    });

    it('cannot be altered or deleted in the database', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      await expect(h.prisma.invoice.update({ where: { id: invoice.id }, data: { totalPaise: 100 } })).rejects.toThrow(/cannot be modified/);
      await expect(h.prisma.invoice.update({ where: { id: invoice.id }, data: { invoiceNumber: 'A1/0000/000009' } })).rejects.toThrow(/cannot be modified/);
      await expect(h.prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toThrow();
      await expect(h.prisma.invoiceItem.updateMany({ where: { invoiceId: invoice.id }, data: { totalPaise: 1 } })).rejects.toThrow(/append-only/);
    });

    it('renders the invoice as a PDF', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)], { customer: { name: 'Asha Rao', phone: '9811122233' } });
      const response = await s.cashier.get(`/invoices/${invoice.id}/pdf`).buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((response.body as Buffer).length).toBeGreaterThan(5000);
    });

    it('counts prints and limits reprints to those allowed', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.cola.id)]);
      expect((await s.cashier.post(`/invoices/${invoice.id}/printed`).expect(200)).body.printCount).toBe(1);
      expect((await s.cashier.post(`/invoices/${invoice.id}/printed`).expect(200)).body.printCount).toBe(2);
      expect(await h.prisma.auditLog.count({ where: { action: 'invoice.reprinted' } })).toBe(1);

      // A role that can bill but not reprint gets one print only.
      const role = await h.prisma.role.findFirstOrThrow({ where: { restaurantId: s.fx.restaurant.id, key: 'cashier' }, include: { permissions: { include: { permission: true } } } });
      await s.owner.patch(`/roles/${role.id}`, { permissions: role.permissions.map((p) => p.permission.key).filter((k) => k !== 'invoice.reprint') }).expect(200);
      expect((await s.cashier.post(`/invoices/${invoice.id}/printed`)).body.code).toBe('REPRINT_NOT_ALLOWED');
    });
  });

  describe('splitting a bill by item', () => {
    it('issues one invoice per part, each with its own number and tax', async () => {
      const paneer = line(s.menu.paneer.id, 3);
      const cola = line(s.menu.cola.id, 2);
      const order = (await saveOrder(s.cashier, { items: [paneer, cola] })).body;
      const response = await s.cashier.post(`/orders/${order.id}/invoices`, {
        parts: [
          [{ orderItemId: paneer.id, quantity: 2 }, { orderItemId: cola.id, quantity: 1 }],
          [{ orderItemId: paneer.id, quantity: 1 }, { orderItemId: cola.id, quantity: 1 }],
        ],
      });
      expect(response.status).toBe(201);
      const [first, second] = response.body;
      expect([first.invoiceNumber, second.invoiceNumber]).toEqual([`A1/${FY}/000001`, `A1/${FY}/000002`]);
      expect([first.totalPaise, second.totalPaise]).toEqual([54600 + 5900, 27300 + 5900]);
      expect(first.items.map((i: { quantity: number }) => i.quantity)).toEqual([2, 1]);
      expect((await s.cashier.get(`/orders/${order.id}`)).body.totals.totalPaise).toBe(first.totalPaise + second.totalPaise);
    });

    it('shares discounts between the parts', async () => {
      const paneer = line(s.menu.paneer.id, 2, { discount: { type: 'AMOUNT', value: 2000 } });
      const order = (await saveOrder(s.owner, { items: [paneer], discount: { type: 'PERCENT', value: 1000 } })).body;
      const [a, b] = (await s.owner.post(`/orders/${order.id}/invoices`, {
        parts: [[{ orderItemId: paneer.id, quantity: 1 }], [{ orderItemId: paneer.id, quantity: 1 }]],
      })).body;
      // Each half: 260 − 10 line discount = 250, less 10% = 225 taxable.
      expect([a.discountPaise, b.discountPaise]).toEqual([3500, 3500]);
      expect([a.taxablePaise, b.taxablePaise]).toEqual([22500, 22500]);
      expect(a.discountPaise + b.discountPaise).toBe(order.totals.discountPaise);
    });

    it('rejects a split that leaves an item out or counts it twice', async () => {
      const paneer = line(s.menu.paneer.id, 2);
      const cola = line(s.menu.cola.id, 1);
      const order = (await saveOrder(s.cashier, { items: [paneer, cola] })).body;
      const attempt = (parts: object[][]) => s.cashier.post(`/orders/${order.id}/invoices`, { parts });
      expect((await attempt([[{ orderItemId: paneer.id, quantity: 2 }], [{ orderItemId: paneer.id, quantity: 1 }]])).body.code).toBe('SPLIT_INCOMPLETE');
      expect((await attempt([[{ orderItemId: paneer.id, quantity: 1 }], [{ orderItemId: cola.id, quantity: 1 }]])).body.code).toBe('SPLIT_INCOMPLETE');
      expect((await attempt([[{ orderItemId: randomUUID(), quantity: 1 }], [{ orderItemId: cola.id, quantity: 1 }]])).body.code).toBe('SPLIT_UNKNOWN_ITEM');
      expect((await attempt([[{ orderItemId: paneer.id, quantity: 2 }, { orderItemId: cola.id, quantity: 1 }]])).status).toBe(400);
      expect(await h.prisma.invoice.count()).toBe(0);
    });
  });

  describe('payments', () => {
    it('takes a split payment, works out change, and settles the order and table', async () => {
      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)] })).body;
      const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, {})).body;
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('BILL_PRINTED');

      const paid = await pay(s.cashier, invoice.id, [
        { method: 'CASH', amountPaise: 30500, tenderedPaise: 50000 },
        { method: 'UPI', amountPaise: 30000, reference: 'UPI-4411' },
      ]);
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({ paymentStatus: 'PAID', paidPaise: 60500 });
      expect(paid.body.payments.map((p: { method: string; amountPaise: number; changePaise: number | null; reference: string | null }) => [p.method, p.amountPaise, p.changePaise, p.reference]))
        .toEqual([['CASH', 30500, 19500, null], ['UPI', 30000, null, 'UPI-4411']]);
      expect((await s.cashier.get(`/orders/${order.id}`)).body.status).toBe('SETTLED');
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('FREE');
    });

    it('accepts part payment and refuses to take more than is due', async () => {
      const { order, invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]); // ₹273
      const part = await pay(s.cashier, invoice.id, [{ method: 'CARD', amountPaise: 10000 }]);
      expect(part.body).toMatchObject({ paymentStatus: 'PARTIALLY_PAID', paidPaise: 10000 });
      expect((await s.cashier.get(`/orders/${order.id}`)).body.status).toBe('BILLED');

      const over = await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 17301 }]);
      expect(over.status).toBe(422);
      expect(over.body).toMatchObject({ code: 'OVERPAYMENT', message: 'Only ₹173.00 is due on this bill.' });

      await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 17300 }]).expect(200);
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 100 }])).body.message).toBe('This bill is already paid in full.');
    });

    it('records a payment once when the same request is sent again', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      const body = { payments: [{ id: randomUUID(), method: 'CASH', amountPaise: 27300 }] };
      const first = await s.cashier.post(`/invoices/${invoice.id}/payments`, body);
      const retry = await s.cashier.post(`/invoices/${invoice.id}/payments`, body);
      expect([first.status, retry.status]).toEqual([200, 200]);
      expect(retry.body).toMatchObject({ paidPaise: 27300, paymentStatus: 'PAID' });
      expect(await h.prisma.payment.count()).toBe(1);
    });

    it('lets only one of two simultaneous full payments through', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      const results = await Promise.all([
        pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }]),
        pay(s.owner, invoice.id, [{ method: 'UPI', amountPaise: 27300 }]),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      const stored = await h.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(stored.paidPaise).toBe(27300);
      expect(await h.prisma.payment.count()).toBe(1);
    });

    it('validates tenders', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300, tenderedPaise: 20000 }])).body.code).toBe('TENDER_INVALID');
      expect((await pay(s.cashier, invoice.id, [{ method: 'UPI', amountPaise: 27300, tenderedPaise: 30000 }])).body.code).toBe('TENDER_INVALID');
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 0 }])).status).toBe(400);
      expect((await pay(s.cashier, invoice.id, [{ method: 'CHEQUE', amountPaise: 100 }])).status).toBe(400);
      expect((await s.cashier.post(`/invoices/${invoice.id}/payments`, { payments: [] })).status).toBe(400);
      expect(await h.prisma.payment.count()).toBe(0);
    });

    it('never lets a payment be edited or deleted in the database', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }]).expect(200);
      const payment = await h.prisma.payment.findFirstOrThrow();
      await expect(h.prisma.payment.update({ where: { id: payment.id }, data: { amountPaise: 1 } })).rejects.toThrow(/cannot be modified/);
      await expect(h.prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('refunds', () => {
    const paidBill = async () => {
      const { order, invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)]); // ₹605
      const paid = (await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 40000 }, { method: 'UPI', amountPaise: 20500 }])).body;
      return { order, invoice: paid, cash: paid.payments[0], upi: paid.payments[1] };
    };
    const refund = (client: Scene['owner'], invoiceId: string, body: object) =>
      client.post(`/invoices/${invoiceId}/refunds`, { id: randomUUID(), reason: 'Customer complaint', ...body });

    it('refunds against a payment and issues a credit note, leaving the invoice untouched', async () => {
      const { invoice, cash } = await paidBill();
      const response = await refund(s.owner, invoice.id, { paymentId: cash.id, amountPaise: 10000 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ISSUED', paymentStatus: 'PARTIALLY_REFUNDED', totalPaise: 60500, paidPaise: 60500, refundedPaise: 10000 });
      expect(response.body.refunds).toMatchObject([{ creditNoteNumber: `C-A1/${FY}/000001`, method: 'CASH', amountPaise: 10000, reason: 'Customer complaint', createdByName: 'Owner' }]);
      expect(response.body.payments[0].refundedPaise).toBe(10000);
    });

    it('cannot refund more than the payment it goes against', async () => {
      const { invoice, cash, upi } = await paidBill();
      const tooMuch = await refund(s.owner, invoice.id, { paymentId: upi.id, amountPaise: 20501 });
      expect(tooMuch.body).toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT', message: 'Only ₹205.00 of this upi payment can still be refunded.' });

      await refund(s.owner, invoice.id, { paymentId: cash.id, amountPaise: 40000 }).expect(200);
      expect((await refund(s.owner, invoice.id, { paymentId: cash.id, amountPaise: 1 })).body.code).toBe('REFUND_EXCEEDS_PAYMENT');
      const full = await refund(s.owner, invoice.id, { paymentId: upi.id, amountPaise: 20500 });
      expect(full.body).toMatchObject({ paymentStatus: 'REFUNDED', refundedPaise: 60500 });
      expect(full.body.refunds.map((r: { creditNoteNumber: string }) => r.creditNoteNumber)).toEqual([`C-A1/${FY}/000001`, `C-A1/${FY}/000002`]);
    });

    it('refunds chosen items for the amount they were billed at, tax included', async () => {
      const { invoice, cash } = await paidBill();
      const paneer = invoice.items[0];
      const response = await refund(s.owner, invoice.id, { paymentId: cash.id, items: [{ invoiceItemId: paneer.id, quantity: 1 }] });
      expect(response.body.refundedPaise).toBe(27300); // one of two at ₹260 + 5%
      expect(response.body.items[0].refundedQuantity).toBe(1);
      const stored = await h.prisma.refund.findFirstOrThrow();
      expect(stored).toMatchObject({ amountPaise: 27300, taxablePaise: 26000, cgstPaise: 650, sgstPaise: 650 });

      expect((await refund(s.owner, invoice.id, { paymentId: cash.id, items: [{ invoiceItemId: paneer.id, quantity: 2 }] })).body.code).toBe('REFUND_QUANTITY');
    });

    it('issues one refund when the same request is sent again', async () => {
      const { invoice, cash } = await paidBill();
      const body = { id: randomUUID(), paymentId: cash.id, amountPaise: 5000, reason: 'Wrong item' };
      await s.owner.post(`/invoices/${invoice.id}/refunds`, body).expect(200);
      const retry = await s.owner.post(`/invoices/${invoice.id}/refunds`, body).expect(200);
      expect(retry.body.refundedPaise).toBe(5000);
      expect(await h.prisma.refund.count()).toBe(1);
    });

    it('needs the refund permission or a manager PIN, and a reason', async () => {
      const { invoice, cash } = await paidBill();
      expect((await refund(s.cashier, invoice.id, { paymentId: cash.id, amountPaise: 1000 })).body.code).toBe('APPROVAL_REQUIRED');
      const approved = await refund(s.cashier, invoice.id, { paymentId: cash.id, amountPaise: 1000, approval: s.ownerApproval });
      expect(approved.status).toBe(200);
      expect(await h.prisma.refund.findFirstOrThrow()).toMatchObject({ createdById: s.fx.cashier.id, approvedById: s.fx.owner.id });
      expect((await s.owner.post(`/invoices/${invoice.id}/refunds`, { id: randomUUID(), paymentId: cash.id, amountPaise: 1000 })).status).toBe(400);
      expect((await refund(s.owner, invoice.id, { paymentId: cash.id })).status).toBe(400);
      expect((await refund(s.owner, invoice.id, { paymentId: randomUUID(), amountPaise: 100 })).body.code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  describe('cancelling a bill', () => {
    it('cancels an unpaid bill, keeps its number, and closes the order', async () => {
      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id)] })).body;
      const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, {})).body;
      expect((await s.cashier.post(`/invoices/${invoice.id}/cancel`, { reason: 'Billed by mistake' })).body.code).toBe('APPROVAL_REQUIRED');

      const cancelled = await s.owner.post(`/invoices/${invoice.id}/cancel`, { reason: 'Billed by mistake' });
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Billed by mistake', invoiceNumber: invoice.invoiceNumber, totalPaise: 27300 });
      expect((await s.owner.get(`/orders/${order.id}`)).body.status).toBe('CANCELLED');
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('FREE');
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }])).body.code).toBe('INVOICE_CANCELLED');

      // The cancelled number is not reused: the next bill takes the next number.
      expect((await billed(s.cashier, [line(s.menu.cola.id)])).invoice.invoiceNumber).toBe(`A1/${FY}/000002`);
    });

    it('can reopen the order to be corrected and billed again', async () => {
      const paneer = line(s.menu.paneer.id);
      const order = (await saveOrder(s.cashier, { items: [paneer] })).body;
      const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, {})).body;
      await s.owner.post(`/invoices/${invoice.id}/cancel`, { reason: 'Wrong quantity', reopenOrder: true }).expect(200);

      const reopened = (await s.owner.get(`/orders/${order.id}`)).body;
      expect(reopened.status).toBe('OPEN');
      await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 2 }], version: reopened.version }, order.id).expect(200);
      const [second] = (await s.cashier.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
      expect(second).toMatchObject({ invoiceNumber: `A1/${FY}/000002`, totalPaise: 54600 });
    });

    it('will not cancel a bill with money against it until that is refunded', async () => {
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id)]);
      const paid = (await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }])).body;
      const blocked = await s.owner.post(`/invoices/${invoice.id}/cancel`, { reason: 'Void' });
      expect(blocked.body).toMatchObject({ code: 'INVOICE_PAID', message: 'This bill has ₹273.00 paid against it. Refund the payment first.' });

      await s.owner.post(`/invoices/${invoice.id}/refunds`, { id: randomUUID(), paymentId: paid.payments[0].id, amountPaise: 27300, reason: 'Void' }).expect(200);
      expect((await s.owner.post(`/invoices/${invoice.id}/cancel`, { reason: 'Void' })).body.status).toBe('CANCELLED');
    });
  });

  describe('listing and access', () => {
    it('lists bills with search and status filters', async () => {
      const a = await billed(s.cashier, [line(s.menu.paneer.id)], { customer: { name: 'Asha Rao', phone: '9811122233' } });
      await billed(s.cashier, [line(s.menu.cola.id)]);
      await pay(s.cashier, a.invoice.id, [{ method: 'CASH', amountPaise: 27300 }]);

      const list = (query: string) => s.owner.get(`/invoices?${query}`).then((r) => (r.body.items as { invoiceNumber: string }[]).map((i) => i.invoiceNumber));
      expect(await list('')).toEqual([`A1/${FY}/000002`, `A1/${FY}/000001`]);
      expect(await list('paymentStatus=PAID')).toEqual([`A1/${FY}/000001`]);
      expect(await list('search=asha')).toEqual([`A1/${FY}/000001`]);
      expect(await list('search=000002')).toEqual([`A1/${FY}/000002`]);
      expect(await list('from=2000-01-01&to=2000-01-02')).toEqual([]);
    });

    it('keeps bills private to their restaurant', async () => {
      const other = await scene(h, 'b');
      const theirs = await billed(other.cashier, [line(other.menu.cola.id)]);
      expect((await s.owner.get(`/invoices/${theirs.invoice.id}`)).status).toBe(404);
      expect((await s.owner.get(`/invoices/${theirs.invoice.id}/pdf`)).status).toBe(404);
      expect((await pay(s.owner, theirs.invoice.id, [{ method: 'CASH', amountPaise: 5900 }])).status).toBe(404);
      expect((await s.owner.post(`/invoices/${theirs.invoice.id}/cancel`, { reason: 'x' })).status).toBe(404);
      expect((await s.owner.get('/invoices')).body.total).toBe(0);
      // Each restaurant has its own invoice sequence.
      expect((await billed(s.cashier, [line(s.menu.cola.id)])).invoice.invoiceNumber).toBe(`A1/${FY}/000001`);
    });

    it('lets the kitchen role neither bill nor take payment', async () => {
      await h.prisma.user.update({ where: { id: s.fx.cashier.id }, data: { roleId: s.fx.roles.kitchen } });
      const kitchen = h.client();
      await kitchen.login(s.fx.cashier.email, undefined, { client: 'pos', terminalId: s.fx.terminal.id });
      expect((await saveOrder(kitchen, { items: [line(s.menu.cola.id)] })).status).toBe(403);
      const { invoice } = await billed(s.owner, [line(s.menu.cola.id)]);
      expect((await pay(kitchen, invoice.id, [{ method: 'CASH', amountPaise: 5900 }])).status).toBe(403);
    });
  });
});
