import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import { line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, PASSWORD, type TestClient } from './support/harness.js';

/**
 * Performance benchmark, run on request only: `PERF=1 pnpm --filter @pos/api test:int test/perf.int-spec.ts`.
 * Set PERF_OUT to a file path to keep the figures as JSON.
 *
 * 1. A large menu: 3,000 products in 60 categories, 300 of them with variants.
 * 2. Six terminals billing at once through the API: 100 orders each (save, send to kitchen, bill, pay).
 * 3. A month of history: those 600 bills copied in the database 150 times over the last 30 days (90,600 bills).
 * 4. Lists, searches, reports and exports timed against that history.
 *
 * The timings are recorded, not asserted, so a slower machine does not fail the run; correctness is asserted.
 */
const PERF = process.env.PERF === '1';
const TODAY = businessDateOf(new Date());
const MONTH_AGO = businessDateOf(new Date(Date.now() - 30 * 86_400_000));

describe.skipIf(!PERF)('performance benchmark', () => {
  let h: Harness;
  let s: Scene;
  const figures: Record<string, unknown> = {};

  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
    s = await scene(h);
  }, 120_000);
  afterAll(async () => {
    await h.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS perf_map');
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(figures, null, 2));
    console.log(JSON.stringify(figures, null, 2));
    await h.close();
  });

  /** The per-address request limit would stop a load test; this clears its counters, nothing else. */
  const clearLimits = async () => {
    const keys = await h.redis.keys('rl:*');
    if (keys.length > 0) await h.redis.del(...keys);
  };
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)!) };
  };
  /** Runs a GET a few times and keeps the median time and the size of the answer. */
  async function time(client: TestClient, path: string, runs = 3) {
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < runs; i += 1) {
      await clearLimits();
      const started = performance.now();
      const response = await client.get(path);
      times.push(performance.now() - started);
      expect(response.status, `${path}: ${JSON.stringify(response.body).slice(0, 200)}`).toBe(200);
      bytes = Number(response.headers['content-length'] ?? JSON.stringify(response.body ?? '').length);
    }
    return { ms: stats(times).p50, kb: Math.round(bytes / 1024) };
  }

  let plain: string[] = [];

  it('1. a large menu', async () => {
    const restaurantId = s.fx.restaurant.id;
    await h.prisma.category.createMany({ data: Array.from({ length: 59 }, (_, i) => ({ restaurantId, name: `Category ${i + 2}`, sortOrder: i + 1 })) });
    const categories = await h.prisma.category.findMany({ where: { restaurantId }, select: { id: true } });
    await h.prisma.product.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        restaurantId, categoryId: categories[i % categories.length]!.id, name: `Menu item ${i + 1}`, shortCode: `M${i + 1}`,
        basePricePaise: 5000 + ((i * 731) % 55_000), stationId: s.fx.station.id,
      })),
    });
    const products = await h.prisma.product.findMany({ where: { restaurantId, name: { startsWith: 'Menu item' } }, select: { id: true }, orderBy: { name: 'asc' } });
    const withVariants = products.slice(0, 300);
    await h.prisma.variant.createMany({
      data: withVariants.flatMap((p) => [
        { productId: p.id, name: 'Small', pricePaise: 10000, isDefault: true },
        { productId: p.id, name: 'Regular', pricePaise: 15000, sortOrder: 1 },
        { productId: p.id, name: 'Large', pricePaise: 20000, sortOrder: 2 },
      ]),
    });
    plain = products.slice(300).map((p) => p.id);

    figures.menu = {
      products: await h.prisma.product.count({ where: { restaurantId } }),
      posBootstrap: await time(s.cashier, '/pos/bootstrap'),
      productsPage: await time(s.owner, '/products?page=1&pageSize=50'),
      productsSearch: await time(s.owner, '/products?search=item%202999'),
    };
  }, 300_000);

  it('2. six terminals billing at once', async () => {
    const terminals = [];
    for (let i = 1; i <= 6; i += 1) {
      const terminal = await h.prisma.terminal.create({ data: { restaurantId: s.fx.restaurant.id, code: `P${i}`, name: `Counter P${i}` } });
      const client = h.client();
      await clearLimits();
      await client.login(s.fx.cashier.email, PASSWORD, { client: 'pos', terminalId: terminal.id });
      terminals.push(client);
    }
    const timing: Record<'save' | 'kitchen' | 'bill' | 'pay', number[]> = { save: [], kitchen: [], bill: [], pay: [] };
    const failures: string[] = [];
    const clock = setInterval(() => void clearLimits(), 500);
    const step = async (name: keyof typeof timing, send: () => PromiseLike<{ status: number; body: any }>) => {
      const started = performance.now();
      const response = await send();
      timing[name].push(performance.now() - started);
      if (response.status >= 300) failures.push(`${name} ${response.status} ${response.body?.code}`);
      return response.body;
    };
    const started = performance.now();
    try {
      await Promise.all(terminals.map(async (client, t) => {
        for (let n = 0; n < 100; n += 1) {
          const pick = (k: number) => plain[(t * 997 + n * 31 + k * 13) % plain.length]!;
          const order = await step('save', () => saveOrder(client, { items: [line(pick(1), 2), line(pick(2)), line(pick(3), 3)] }));
          await step('kitchen', () => client.post(`/orders/${order.id}/kots`));
          const [invoice] = await step('bill', () => client.post(`/orders/${order.id}/invoices`, {}));
          await step('pay', () => pay(client, invoice.id, [{ method: n % 3 === 0 ? 'UPI' : 'CASH', amountPaise: invoice.totalPaise }]));
        }
      }));
    } finally {
      clearInterval(clock);
    }
    const seconds = (performance.now() - started) / 1000;
    expect(failures).toEqual([]);
    // Every terminal's bills are numbered 1 to 100 with no gap or repeat.
    const series = await h.prisma.$queryRaw<{ prefix: string; n: bigint; max: number; distinct: bigint }[]>`
      SELECT s.prefix, COUNT(*) AS n, MAX(i.number) AS max, COUNT(DISTINCT i.number) AS distinct
      FROM invoices i JOIN number_series s ON s.id = i.series_id GROUP BY s.prefix ORDER BY s.prefix`;
    expect(series.map((row) => [row.prefix, Number(row.n), row.max, Number(row.distinct)])).toEqual(
      ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((prefix) => [prefix, 100, 100, 100]),
    );
    const kitchen = await h.prisma.kotItem.aggregate({ _sum: { quantity: true } });
    expect(kitchen._sum.quantity).toBe(600 * 6);
    figures.concurrentBilling = {
      terminals: 6, bills: 600, seconds: Math.round(seconds), billsPerMinute: Math.round((600 / seconds) * 60),
      save: stats(timing.save), sendToKitchen: stats(timing.kitchen), bill: stats(timing.bill), pay: stats(timing.pay),
    };
  }, 600_000);

  it('3. a month of history', async () => {
    const restaurantId = s.fx.restaurant.id;
    const copies = 150;
    const sources = await h.prisma.terminal.findMany({ where: { restaurantId, code: { startsWith: 'P' } }, orderBy: { code: 'asc' } });
    await h.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS perf_map');
    await h.prisma.$executeRawUnsafe('CREATE UNLOGGED TABLE perf_map (old uuid NOT NULL, k int NOT NULL, new uuid NOT NULL, PRIMARY KEY (old, k))');
    // One terminal per copy of each source terminal, coded Z000 to Z383 so the order and bill series stay within four characters.
    const terminals = sources.flatMap((source, j) => Array.from({ length: copies }, (_, i) => ({
      old: source.id, k: i + 1, id: randomUUID(), code: 'Z' + (i * sources.length + j).toString(16).toUpperCase().padStart(3, '0'),
    })));
    await h.prisma.terminal.createMany({ data: terminals.map((t) => ({ id: t.id, restaurantId, code: t.code, name: `History ${t.code}` })) });
    await h.prisma.$executeRawUnsafe(`INSERT INTO perf_map (old, k, new) VALUES ${terminals.map((t) => `('${t.old}', ${t.k}, '${t.id}')`).join(',')}`);

    const started = performance.now();
    const ks = `generate_series(1, ${copies})`;
    const mapped = (column: string) => `(SELECT new FROM perf_map WHERE old = t.${column} AND k = m.k)`;
    const code = `(SELECT code FROM terminals WHERE id = ${mapped('terminal_id')})`;
    const days = '((m.k % 30) + 1)';
    const shiftTime = (column: string) => `t.${column} - ${days} * interval '1 day'`;
    for (const table of ['number_series', 'orders', 'order_items', 'invoices', 'invoice_items']) {
      const filter = table === 'order_items' ? `order_id IN (SELECT id FROM orders WHERE restaurant_id = '${restaurantId}')`
        : table === 'invoice_items' ? `invoice_id IN (SELECT id FROM invoices WHERE restaurant_id = '${restaurantId}')`
        : `restaurant_id = '${restaurantId}'`;
      await h.prisma.$executeRawUnsafe(`INSERT INTO perf_map (old, k, new) SELECT id, k, gen_random_uuid() FROM ${table} CROSS JOIN ${ks} AS k WHERE ${filter}`);
    }
    async function copy(table: string, join: string, replace: Record<string, string>) {
      const columns = (await h.prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position`,
      )).map((c) => c.column_name);
      const list = columns.map((c) => `"${c}"`).join(', ');
      const select = columns.map((c) => replace[c] ?? `t."${c}"`).join(', ');
      await h.prisma.$executeRawUnsafe(`INSERT INTO "${table}" (${list}) SELECT ${select} FROM "${table}" t ${join}`);
    }
    const ownRows = (table: string) => `JOIN perf_map m ON m.old = t.id WHERE t.id IN (SELECT old FROM perf_map) AND t.${table === 'number_series' || table === 'orders' || table === 'invoices' ? `restaurant_id = '${restaurantId}'` : 'id IS NOT NULL'}`;
    await copy('number_series', `${ownRows('number_series')} AND t.terminal_id IN (SELECT old FROM perf_map)`, {
      id: 'm.new', terminal_id: mapped('terminal_id'), prefix: code,
    });
    await copy('orders', ownRows('orders'), {
      id: 'm.new', terminal_id: mapped('terminal_id'), series: code, table_id: 'NULL', merged_into_id: 'NULL',
      business_date: `t.business_date - ${days}`, created_at: shiftTime('created_at'), updated_at: shiftTime('updated_at'),
    });
    await copy('order_items', ownRows('order_items'), { id: 'm.new', order_id: mapped('order_id') });
    await copy('invoices', ownRows('invoices'), {
      id: 'm.new', order_id: mapped('order_id'), terminal_id: mapped('terminal_id'), series_id: mapped('series_id'),
      invoice_number: `${code} || substring(t.invoice_number from position('/' in t.invoice_number))`,
      business_date: `t.business_date - ${days}`, issued_at: shiftTime('issued_at'), created_at: shiftTime('created_at'), updated_at: shiftTime('updated_at'),
    });
    await copy('invoice_items', ownRows('invoice_items'), { id: 'm.new', invoice_id: mapped('invoice_id'), order_item_id: mapped('order_item_id') });
    await copy('invoice_taxes', `JOIN perf_map m ON m.old = t.invoice_id`, { id: 'gen_random_uuid()', invoice_id: 'm.new' });
    await copy('payments', `JOIN perf_map m ON m.old = t.invoice_id`, {
      id: 'gen_random_uuid()', invoice_id: 'm.new', idempotency_key: `t.idempotency_key || ':h' || m.k`, register_session_id: 'NULL',
      business_date: `t.business_date - ${days}`, paid_at: shiftTime('paid_at'), created_at: shiftTime('created_at'), updated_at: shiftTime('updated_at'),
    });
    await h.prisma.$executeRawUnsafe('ANALYZE');

    const counts = await h.prisma.$queryRaw<{ orders: bigint; invoices: bigint; items: bigint; payments: bigint }[]>`
      SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM invoices) AS invoices,
             (SELECT COUNT(*) FROM invoice_items) AS items, (SELECT COUNT(*) FROM payments) AS payments`;
    expect(Number(counts[0]!.invoices)).toBe(600 * (copies + 1));
    figures.history = { ...Object.fromEntries(Object.entries(counts[0]!).map(([k, v]) => [k, Number(v)])), loadSeconds: Math.round((performance.now() - started) / 1000) };
  }, 600_000);

  it('4. lists, searches, reports and exports over a month of history', async () => {
    const range = `from=${MONTH_AGO}&to=${TODAY}`;
    const reports: Record<string, unknown> = {};
    for (const type of ['sales-daily', 'sales-monthly', 'orders', 'items', 'item-summary', 'categories', 'gst', 'hsn', 'payments', 'payment-summary', 'discounts', 'cashiers']) {
      reports[type] = await time(s.owner, `/reports/${type}?${range}`, 2);
    }
    const exportTimes: Record<string, number> = {};
    for (const format of ['csv', 'xlsx', 'pdf']) {
      await clearLimits();
      const started = performance.now();
      const response = await s.owner.get(`/reports/sales-daily/export?${range}&format=${format}`).buffer(true);
      exportTimes[format] = response.status === 200 ? Math.round(performance.now() - started) : -response.status;
    }
    figures.queries = {
      ordersFirstPage: await time(s.owner, '/orders?page=1&pageSize=50'),
      ordersSortedByBill: await time(s.owner, '/orders?page=1&pageSize=50&sort=bill', 1),
      ordersSortedByPayment: await time(s.owner, '/orders?page=1&pageSize=50&sort=billingType', 1),
      ordersSearchBillNumber: await time(s.owner, '/orders?search=Z07F'),
      invoicesFirstPage: await time(s.owner, '/invoices?page=1&pageSize=50'),
      invoicesSortedByCashier: await time(s.owner, '/invoices?page=1&pageSize=50&sort=cashier', 1),
      invoicesSearch: await time(s.owner, '/invoices?search=Z07F'),
      runningOrders: await time(s.cashier, '/orders/running'),
      posBootstrap: await time(s.cashier, '/pos/bootstrap'),
      dashboard: await time(s.owner, '/dashboard'),
      kitchenToday: await time(s.owner, '/kots?scope=today'),
      reports,
      exports: exportTimes,
    };
  }, 600_000);

  it('5. the same payment sent twenty times at once is recorded once', async () => {
    const order = (await saveOrder(s.cashier, { items: [line(plain[0]!)] }).expect(200)).body;
    const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
    const body = { payments: [{ id: randomUUID(), method: 'CASH', amountPaise: invoice.totalPaise }] };
    await clearLimits();
    const results = await Promise.all(Array.from({ length: 20 }, () => s.cashier.post(`/invoices/${invoice.id}/payments`, body)));
    expect(results.map((r) => r.status).filter((status) => status !== 200)).toEqual([]);
    expect(await h.prisma.payment.count({ where: { invoiceId: invoice.id } })).toBe(1);
    figures.repeatedPayment = { requests: 20, paymentsRecorded: 1 };
  });
});
