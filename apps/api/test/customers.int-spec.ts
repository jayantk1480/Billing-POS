import { randomUUID } from 'node:crypto';
import { billed, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness } from './support/harness.js';

/**
 * Customer records: identified by mobile number, written with orders, read in the back office, and looked up by
 * number at the counter.
 */
describe('customers', () => {
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

  const asha = { name: 'Asha Mehta', phone: '9800012345' };
  const customers = async (query = '') => (await s.owner.get('/customers' + query).expect(200)).body as { items: any[]; total: number };
  const record = async (id: string) => (await s.owner.get('/customers/' + id).expect(200)).body;

  it('identifies a customer by mobile number: one number is one record however it is typed, and typed details replace those on record', async () => {
    await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)], customer: asha }).expect(200);
    await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { name: 'Asha M', phone: '+91 98000 12345', address: 'Pune' } }).expect(200);
    // The number alone: nothing typed, so nothing on record changes.
    await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { phone: '098000-12345' } }).expect(200);
    const { items, total } = await customers();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ name: 'Asha M', phone: '9800012345', address: 'Pune', orderCount: 3 });
    // The order carries the number as its 10 digits too.
    const order = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { phone: '+91 98000 12345' } }).expect(200)).body;
    expect(order.customer).toEqual({ name: 'Asha M', phone: '9800012345', gstin: null, address: 'Pune' });
  });

  it('needs a mobile number; a name alone, or a number that is not a mobile, is refused', async () => {
    for (const customer of [{ name: 'Rohit' }, { name: 'Rohit', phone: '' }, { name: 'Rohit', phone: '12345' }, { phone: '1234567890' }, { phone: '98000123456' }]) {
      const response = await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer });
      expect(response.status, JSON.stringify(customer)).toBe(400);
      expect(response.body.details.map((issue: any) => issue.path)).toContain('customer.phone');
    }
    expect(await h.prisma.customer.count()).toBe(0);
    // A number alone is enough; the name is for the bill.
    await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { phone: '9800012345' } }).expect(200);
    expect((await customers()).items[0]).toMatchObject({ name: null, phone: '9800012345' });
  });

  it('makes one record when several tills type the same new number at once', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { name: `Till ${i}`, phone: '9800012345' } })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const { items, total } = await customers();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ phone: '9800012345', orderCount: 4 });
  });

  it('keeps a customer on record when an order drops them', async () => {
    const order = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: asha }).expect(200)).body;
    await saveOrder(s.cashier, { items: order.items.map((item: any) => ({ id: item.id, productId: item.productId, quantity: 1 })), customer: null }, order.id).expect(200);
    expect((await customers()).items.map((c) => [c.phone, c.orderCount])).toEqual([['9800012345', 0]]);
  });

  it('lists each customer with their orders, what they spent and their last order; finds them by number or name', async () => {
    const first = await billed(s.cashier, [line(s.menu.paneer.id)], { customer: asha });
    await pay(s.cashier, first.invoice.id, [{ method: 'CASH', amountPaise: 27300 }]).expect(200);
    await billed(s.cashier, [line(s.menu.cola.id)], { customer: asha }); // billed, not paid: not spent yet
    const cancelled = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: asha }).expect(200)).body;
    await s.owner.post(`/orders/${cancelled.id}/cancel`, { reason: 'Left' }).expect(200);
    const other = await billed(s.cashier, [line(s.menu.cola.id, 2)], { customer: { name: 'Bharat Traders', phone: '9800099999' } });
    await pay(s.cashier, other.invoice.id, [{ method: 'UPI', amountPaise: other.invoice.totalPaise }]).expect(200);

    const { items } = await customers('?sort=spent&direction=desc');
    expect(items.map((c) => [c.phone, c.name, c.orderCount, c.spentPaise])).toEqual([['9800012345', 'Asha Mehta', 2, 27300], ['9800099999', 'Bharat Traders', 1, other.invoice.totalPaise]]);
    expect(items[0].lastOrderAt).toEqual(expect.any(String));

    expect((await customers('?search=ash')).items.map((c) => c.phone)).toEqual(['9800012345']);
    expect((await customers('?search=99999')).items.map((c) => c.phone)).toEqual(['9800099999']);
    expect((await customers('?search=%2B91%2098000%2012')).items.map((c) => c.phone)).toEqual(['9800012345']); // typed with the country code
    expect((await customers('?search=098000')).items.map((c) => c.phone).sort()).toEqual(['9800012345', '9800099999']);
    expect((await customers('?search=nobody')).total).toBe(0);
    expect((await customers('?sort=phone&direction=asc&pageSize=1')).items.map((c) => c.phone)).toEqual(['9800012345']);
    expect((await customers('?sort=phone&direction=asc&pageSize=1&page=2')).items.map((c) => c.phone)).toEqual(['9800099999']);
    expect((await s.owner.get('/customers?sort=secret')).status).toBe(400);
  });

  it('shows one customer with every order: number, bill, amount and status', async () => {
    const paid = await billed(s.cashier, [line(s.menu.paneer.id)], { customer: asha });
    await pay(s.cashier, paid.invoice.id, [{ method: 'CASH', amountPaise: 27300 }]).expect(200);
    const open = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: asha }).expect(200)).body;
    const { items } = await customers();
    const customer = await record(items[0].id);
    expect(customer).toMatchObject({ name: 'Asha Mehta', phone: '9800012345', orderCount: 2, spentPaise: 27300 });
    expect(customer.orders.map((order: any) => [order.displayNumber, order.invoiceNumbers, order.totalPaise, order.paidPaise, order.status])).toEqual([
      [open.displayNumber, [], 5900, 0, 'OPEN'],
      [paid.order.displayNumber, [paid.invoice.invoiceNumber], 27300, 27300, 'SETTLED'],
    ]);
    // The bill carries the number and the name it was issued with.
    expect((await s.owner.get('/invoices/' + paid.invoice.id).expect(200)).body.customer).toMatchObject({ name: 'Asha Mehta', phone: '9800012345' });
  });

  it('offers customers whose number begins with the digits typed, from three digits on, and never more than eight', async () => {
    for (const [i, phone] of ['9800012345', '9800099999', '9811122233', '7000000001'].entries()) {
      await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { name: `Customer ${i}`, phone } }).expect(200);
    }
    const suggest = async (typed: string) => (await s.cashier.get('/customers/suggest?phone=' + encodeURIComponent(typed)).expect(200)).body as { phone: string; name: string | null; orderCount: number }[];
    expect((await suggest('98')).length).toBe(0);
    expect((await suggest('980')).map((c) => c.phone)).toEqual(['9800012345', '9800099999']);
    expect((await suggest('+91 98000 1')).map((c) => c.phone)).toEqual(['9800012345']);
    expect((await suggest('0981')).map((c) => [c.phone, c.name, c.orderCount])).toEqual([['9811122233', 'Customer 2', 1]]);
    expect((await suggest('12345')).length).toBe(0); // the middle of a number is not the start of it
    for (let i = 0; i < 12; i += 1) await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { phone: `98000${String(i).padStart(5, '0')}` } }).expect(200);
    expect((await suggest('98000')).length).toBe(8);
    // Another restaurant's customers are not offered.
    const other = await scene(h, 'b');
    expect(await (await other.cashier.get('/customers/suggest?phone=980').expect(200)).body).toEqual([]);
  });

  it('finds a customer by mobile number for the billing screen, however it is typed, and tells of nobody else', async () => {
    await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { ...asha, address: '12 MG Road' } }).expect(200);
    for (const typed of ['9800012345', '%2B91%2098000%2012345', '0980001-2345']) {
      const found = (await s.cashier.get('/customers/lookup?phone=' + typed).expect(200)).body;
      expect(found.customer, typed).toMatchObject({ name: 'Asha Mehta', phone: '9800012345', address: '12 MG Road', orderCount: 1 });
    }
    expect((await s.cashier.get('/customers/lookup?phone=9800000000').expect(200)).body).toEqual({ customer: null });
    expect((await s.cashier.get('/customers/lookup?phone=12345')).status).toBe(400);

    const other = await scene(h, 'b');
    expect((await other.cashier.get('/customers/lookup?phone=9800012345').expect(200)).body).toEqual({ customer: null });
  });

  it('is for those who may see every order, within their own restaurant', async () => {
    await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: asha }).expect(200);
    expect((await s.cashier.get('/customers')).status).toBe(403);
    const { items } = await customers();
    expect((await s.cashier.get('/customers/' + items[0].id)).status).toBe(403);

    const other = await scene(h, 'b');
    // The same number at another restaurant is that restaurant's own customer.
    await saveOrder(other.cashier, { items: [line(other.menu.cola.id)], customer: { name: 'Someone Else', phone: '9800012345' } }).expect(200);
    expect((await other.owner.get('/customers').expect(200)).body.items.map((c: any) => c.name)).toEqual(['Someone Else']);
    expect((await customers()).items.map((c) => c.name)).toEqual(['Asha Mehta']);
    expect((await other.owner.get('/customers/' + items[0].id)).status).toBe(404);
    expect((await other.owner.get('/customers/' + randomUUID())).status).toBe(404);
  });
});
