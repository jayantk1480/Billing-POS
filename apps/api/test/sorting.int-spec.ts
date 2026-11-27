import { businessDateOf } from '@pos/billing-core';
import { billed, FY, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness } from './support/harness.js';

const TODAY = businessDateOf(new Date());
const range = 'from=' + TODAY + '&to=' + TODAY;

/** Sorting the paged lists by any column, in either direction, across all of their pages. */
describe('sorting lists', () => {
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

  /** Three orders: cola paid by UPI by the cashier (₹59), paneer ×2 paid in cash by the owner (₹546), and one unbilled paneer (₹273). */
  async function three() {
    const cola = await billed(s.cashier, [line(s.menu.cola.id, 1)], { customer: { name: 'Zoya', phone: '9800000031' } });
    await pay(s.cashier, cola.invoice.id, [{ method: 'UPI', amountPaise: 5900 }]).expect(200);
    const paneer = await billed(s.owner, [line(s.menu.paneer.id, 2)], { customer: { name: 'Asha', phone: '9800000032' } });
    await pay(s.owner, paneer.invoice.id, [{ method: 'CASH', amountPaise: 54600 }]).expect(200);
    const open = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1)] }).expect(200)).body;
    return { cola, paneer, open };
  }
  const orders = async (query: string) => ((await s.owner.get(`/orders?${range}&${query}`).expect(200)).body.items as { displayNumber: string }[]).map((row) => row.displayNumber);
  const bills = async (query: string) => ((await s.owner.get(`/invoices?${range}&${query}`).expect(200)).body.items as { invoiceNumber: string }[]).map((row) => row.invoiceNumber.slice(-1));

  it('sorts orders by each column, both ways', async () => {
    await three();   // A1-1 cola, A1-2 paneer ×2, A1-3 open
    expect(await orders('')).toEqual(['A1-3', 'A1-2', 'A1-1']);   // newest first unless asked otherwise
    expect(await orders('sort=order&direction=asc')).toEqual(['A1-1', 'A1-2', 'A1-3']);
    expect(await orders('sort=order&direction=desc')).toEqual(['A1-3', 'A1-2', 'A1-1']);
    expect(await orders('sort=total&direction=asc')).toEqual(['A1-1', 'A1-3', 'A1-2']);
    expect(await orders('sort=total&direction=desc')).toEqual(['A1-2', 'A1-3', 'A1-1']);
    expect(await orders('sort=takenBy&direction=asc')).toEqual(['A1-3', 'A1-1', 'A1-2']);   // Cashier, Cashier (newest first), Owner
    expect(await orders('sort=date&direction=asc')).toEqual(['A1-1', 'A1-2', 'A1-3']);
    // Columns that come from an order's bills. Orders with nothing in the column stay last either way.
    expect(await orders('sort=bill&direction=asc')).toEqual(['A1-1', 'A1-2', 'A1-3']);
    expect(await orders('sort=bill&direction=desc')).toEqual(['A1-2', 'A1-1', 'A1-3']);
    expect(await orders('sort=billingType&direction=asc')).toEqual(['A1-2', 'A1-1', 'A1-3']);   // Cash, UPI, not paid
    expect(await orders('sort=billingType&direction=desc')).toEqual(['A1-1', 'A1-2', 'A1-3']);
    expect(await orders('sort=status&direction=asc')).toHaveLength(3);
    expect(await orders('sort=type&direction=desc')).toHaveLength(3);
  });

  it('sorts across pages, not only within the page shown', async () => {
    await three();
    expect(await orders('sort=total&direction=desc&pageSize=1&page=1')).toEqual(['A1-2']);
    expect(await orders('sort=total&direction=desc&pageSize=1&page=3')).toEqual(['A1-1']);
    expect(await orders('sort=bill&direction=desc&pageSize=2&page=2')).toEqual(['A1-3']);
    expect((await s.owner.get(`/orders?${range}&sort=bill&pageSize=1&page=2`).expect(200)).body).toMatchObject({ total: 3, page: 2, pageSize: 1 });
  });

  it('sorts bills by each column, both ways', async () => {
    await three();   // bill 1: cola ₹59 by Cashier for Zoya; bill 2: paneer ₹546 by Owner for Asha
    expect(await bills('')).toEqual(['2', '1']);
    expect(await bills('sort=bill&direction=asc')).toEqual(['1', '2']);
    expect(await bills('sort=total&direction=desc')).toEqual(['2', '1']);
    expect(await bills('sort=paid&direction=asc')).toEqual(['1', '2']);
    expect(await bills('sort=customer&direction=asc')).toEqual(['2', '1']);
    expect(await bills('sort=customer&direction=desc')).toEqual(['1', '2']);
    expect(await bills('sort=cashier&direction=asc')).toEqual(['1', '2']);
    expect(await bills('sort=cashier&direction=desc')).toEqual(['2', '1']);
    expect(await bills('sort=order&direction=asc')).toEqual(['1', '2']);
    expect(await bills('sort=issued&direction=asc')).toEqual(['1', '2']);
    expect(await bills('sort=status&direction=asc')).toHaveLength(2);
    expect((await s.owner.get(`/invoices?${range}&sort=bill`).expect(200)).body.items[0].invoiceNumber).toBe(`A1/${FY}/000001`);
  });

  it('sorts products by each column, both ways', async () => {
    const names = async (query: string) => ((await s.owner.get(`/products?${query}`).expect(200)).body.items as { name: string }[]).map((row) => row.name);
    const byName = await names('sort=product&direction=asc');
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
    expect(await names('sort=product&direction=desc')).toEqual([...byName].reverse());
    const prices = async (direction: string) => ((await s.owner.get(`/products?sort=price&direction=${direction}`).expect(200)).body.items as { basePricePaise: number }[]).map((row) => row.basePricePaise);
    const ascending = await prices('asc');
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
    expect(await prices('desc')).toEqual([...ascending].reverse());
    for (const column of ['category', 'tax', 'available']) expect(await names(`sort=${column}&direction=desc`)).toHaveLength(byName.length);
  });

  it('refuses a column or direction it does not know', async () => {
    expect((await s.owner.get('/orders?sort=secret')).status).toBe(400);
    expect((await s.owner.get('/orders?sort=total&direction=sideways')).status).toBe(400);
    expect((await s.owner.get('/invoices?sort=createdById')).status).toBe(400);
    expect((await s.owner.get('/products?sort=price;drop')).status).toBe(400);
  });
});
