import { io, type Socket } from 'socket.io-client';
import { billed, line, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, type TestClient } from './support/harness.js';

type Kot = {
  id: string; kotNumber: number; type: string; status: string; stationName: string | null; orderDisplayNumber: string; tableName: string | null;
  notes: string | null; items: { name: string; quantity: number; notes: string | null }[]; printCount: number; preparingAt: string | null; readyAt: string | null; completedAt: string | null;
};

describe('kitchen tickets, floor and live notices', () => {
  let h: Harness;
  let s: Scene;
  let kitchen: TestClient;
  let barId: string;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Food goes to the Main Kitchen, cola to the Bar, and a kitchen user is signed in. */
  beforeEach(async () => {
    await h.reset();
    s = await scene(h);
    const bar = await h.prisma.kitchenStation.create({ data: { restaurantId: s.fx.restaurant.id, name: 'Bar', sortOrder: 1 } });
    barId = bar.id;
    await h.prisma.product.updateMany({ where: { id: { in: [s.menu.paneer.id, s.menu.chicken.id, s.menu.biryani.id] } }, data: { stationId: s.fx.station.id } });
    await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { stationId: bar.id } });
    await s.owner.post('/users', { name: 'Chef', email: 'chef@test.local', roleId: s.fx.roles.kitchen, password: 'a long enough password' }).expect(201);
    kitchen = h.client();
    await kitchen.login('chef@test.local', 'a long enough password', { client: 'kds' });
  });

  const fire = (client: TestClient, orderId: string) => client.post('/orders/' + orderId + '/kots');
  const tickets = async (query = '') => (await kitchen.get('/kots' + query).expect(200)).body as Kot[];

  describe('sending to the kitchen', () => {
    it('creates one ticket per station, with variants, add-ons and notes', async () => {
      const order = (await saveOrder(s.cashier, {
        type: 'DINE_IN', tableId: s.menu.t1.id,
        items: [
          line(s.menu.paneer.id, 2),
          line(s.menu.chicken.id, 1, { variantId: s.menu.full.id }),
          line(s.menu.biryani.id, 1, { modifierIds: [s.menu.spicy.id, s.menu.raita.id], notes: 'No onion' }),
          line(s.menu.cola.id, 3),
        ],
      })).body;
      const sent = (await fire(s.cashier, order.id).expect(200)).body as Kot[];

      expect(sent.map((kot) => [kot.kotNumber, kot.stationName, kot.type, kot.status, kot.orderDisplayNumber, kot.tableName])).toEqual([
        [1, 'Main Kitchen', 'NEW', 'PENDING', 'A1-1', 'T1'],
        [2, 'Bar', 'NEW', 'PENDING', 'A1-1', 'T1'],
      ]);
      const food = sent[0]!.items;
      expect(food.map((item) => [item.name, item.quantity])).toEqual([['Paneer Tikka', 2], ['Tandoori Chicken (Full)', 1], ['Veg Biryani', 1]]);
      expect(food[2]!.notes).toContain('Spicy');
      expect(food[2]!.notes).toContain('Raita');
      expect(food[2]!.notes).toContain('No onion');
      expect(sent[1]!.items).toMatchObject([{ name: 'Cola', quantity: 3 }]);
      expect((await s.cashier.get('/orders/' + order.id)).body.items.map((item: { kotQuantity: number }) => item.kotQuantity)).toEqual([2, 1, 1, 3]);
    });

    it('sends only what is new the next time', async () => {
      const paneer = line(s.menu.paneer.id, 1);
      const order = (await saveOrder(s.cashier, { items: [paneer] })).body;
      await fire(s.cashier, order.id).expect(200);
      expect((await fire(s.cashier, order.id).expect(200)).body).toEqual([]);

      const updated = (await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 3 }, line(s.menu.cola.id, 1)], version: order.version + 0 }, order.id));
      expect(updated.status).toBe(200);
      const second = (await fire(s.cashier, order.id).expect(200)).body as Kot[];
      expect(second.map((kot) => [kot.kotNumber, kot.stationName, kot.items.map((item) => [item.name, item.quantity])])).toEqual([
        [2, 'Main Kitchen', [['Paneer Tikka', 2]]],
        [3, 'Bar', [['Cola', 1]]],
      ]);
    });

    it('skips items marked as never going to the kitchen without sending them again later', async () => {
      await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { sendToKitchen: false } });
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 2), line(s.menu.paneer.id, 1)] })).body;
      const sent = (await fire(s.cashier, order.id)).body as Kot[];
      expect(sent).toHaveLength(1);
      expect(sent[0]!.items.map((item) => item.name)).toEqual(['Paneer Tikka']);
      expect((await fire(s.cashier, order.id)).body).toEqual([]);
    });

    it('sends an item with no station of its own, or a switched-off one, to the first active station', async () => {
      // As a product added without choosing a station: before this, it never reached the kitchen at all.
      await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { stationId: null } });
      const first = (await fire(s.cashier, (await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 2)] })).body.id).expect(200)).body as Kot[];
      expect(first.map((kot) => [kot.stationName, kot.items.map((item) => [item.name, item.quantity])])).toEqual([['Main Kitchen', [['Cola', 2]]]]);

      // The first station in the list is the default; one that is switched off is passed over, for products on it too.
      await h.prisma.kitchenStation.update({ where: { id: s.fx.station.id }, data: { isActive: false } });
      const second = (await fire(s.cashier, (await saveOrder(s.cashier, { items: [line(s.menu.cola.id), line(s.menu.paneer.id)] })).body.id).expect(200)).body as Kot[];
      expect(second.map((kot) => [kot.stationName, kot.items.map((item) => item.name)])).toEqual([['Bar', ['Cola', 'Paneer Tikka']]]);

      // With no station at all there is nowhere to send it, so there is no ticket, as before.
      await h.prisma.kitchenStation.update({ where: { id: barId }, data: { isActive: false } });
      expect((await fire(s.cashier, (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })).body.id).expect(200)).body).toEqual([]);
    });

    it('keeps the kitchen choice on the product, and the form sets it', async () => {
      const created = await s.owner.post('/products', { categoryId: s.fx.category.id, name: 'Mineral Water', basePricePaise: 2000, sendToKitchen: false }).expect(201);
      expect(created.body).toMatchObject({ stationId: null, sendToKitchen: false });
      const plain = await s.owner.post('/products', { categoryId: s.fx.category.id, name: 'Masala Chai', basePricePaise: 3000 }).expect(201);
      expect(plain.body).toMatchObject({ stationId: null, sendToKitchen: true });
      const sent = (await fire(s.cashier, (await saveOrder(s.cashier, { items: [line(created.body.id), line(plain.body.id)] })).body.id).expect(200)).body as Kot[];
      expect(sent.map((kot) => [kot.stationName, kot.items.map((item) => item.name)])).toEqual([['Main Kitchen', ['Masala Chai']]]);
      const changed = await s.owner.patch('/products/' + created.body.id, { sendToKitchen: true, stationId: barId }).expect(200);
      expect(changed.body).toMatchObject({ stationId: barId, sendToKitchen: true });
    });

    it('makes kitchen tickets only from KOT: billing sends nothing to the kitchen', async () => {
      // Decided 2026-11-24: an order billed without pressing KOT never reaches the kitchen.
      await billed(s.cashier, [line(s.menu.paneer.id, 1), line(s.menu.cola.id, 1)]);
      expect(await tickets('?scope=today')).toEqual([]);
      // Items sent with KOT before billing are on their tickets, once.
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 2)] })).body;
      await fire(s.cashier, order.id).expect(200);
      await s.cashier.post('/orders/' + order.id + '/invoices', {}).expect(201);
      expect((await tickets('?scope=today')).map((kot) => [kot.stationName, kot.items.map((item) => [item.name, item.quantity])])).toEqual([['Main Kitchen', [['Paneer Tikka', 2]]]]);
    });

    it('needs the right to send, and an order that is still open', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1)] })).body;
      expect((await fire(kitchen, order.id)).status).toBe(403);
      await s.cashier.post('/orders/' + order.id + '/invoices', {}).expect(201);
      expect((await fire(s.cashier, order.id)).body.code).toBe('ORDER_LOCKED');
    });
  });

  describe('changing what was already sent', () => {
    it('needs a reason and a manager, and sends the kitchen a cancellation', async () => {
      const paneer = line(s.menu.paneer.id, 3);
      const cola = line(s.menu.cola.id, 1);
      const order = (await saveOrder(s.cashier, { items: [paneer, cola] })).body;
      await fire(s.cashier, order.id).expect(200);
      const change = { items: [{ ...paneer, quantity: 1 }], version: (await s.cashier.get('/orders/' + order.id)).body.version };

      const noReason = await saveOrder(s.cashier, change, order.id);
      expect(noReason.status).toBe(422);
      expect(noReason.body).toMatchObject({ code: 'KOT_CANCEL_REASON_REQUIRED', details: { items: ['Paneer Tikka', 'Cola'] } });
      const noManager = await saveOrder(s.cashier, { ...change, kotCancelReason: 'Guest changed their mind' }, order.id);
      expect(noManager.body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'kot.cancel_item' } });
      expect(await h.prisma.kot.count()).toBe(2); // nothing changed yet

      const done = await saveOrder(s.cashier, { ...change, kotCancelReason: 'Guest changed their mind', approval: s.ownerApproval }, order.id);
      expect(done.status).toBe(200);
      expect(done.body.items).toMatchObject([{ name: 'Paneer Tikka', quantity: 1, kotQuantity: 1 }]);

      const cancels = (await tickets()).filter((kot) => kot.type === 'CANCEL');
      expect(cancels.map((kot) => [kot.stationName, kot.notes, kot.items.map((item) => [item.name, item.quantity])])).toEqual([
        ['Main Kitchen', 'Guest changed their mind', [['Paneer Tikka', 2]]],
        ['Bar', 'Guest changed their mind', [['Cola', 1]]],
      ]);
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'kot.items_cancelled' } });
      expect(audit).toMatchObject({ userId: s.fx.cashier.id, reason: 'Guest changed their mind', after: { approvedBy: s.fx.owner.id } });
    });

    it('lets items that were never sent be removed freely, and quantities go up freely', async () => {
      const paneer = line(s.menu.paneer.id, 1);
      const order = (await saveOrder(s.cashier, { items: [paneer, line(s.menu.cola.id, 1)] })).body;
      await saveOrder(s.cashier, { items: [paneer], version: order.version }, order.id).expect(200);
      await fire(s.cashier, order.id).expect(200);
      const version = (await s.cashier.get('/orders/' + order.id)).body.version;
      await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 4 }], version }, order.id).expect(200);
    });

    it('does not let a sent item be swapped for a different variant', async () => {
      const chicken = line(s.menu.chicken.id, 1, { variantId: s.menu.half.id });
      const order = (await saveOrder(s.owner, { items: [chicken] })).body;
      await fire(s.owner, order.id).expect(200);
      const version = (await s.owner.get('/orders/' + order.id)).body.version;
      const swapped = await saveOrder(s.owner, { items: [{ ...chicken, variantId: s.menu.full.id }], version }, order.id);
      expect(swapped.body.code).toBe('ITEM_ALREADY_SENT');
    });

    it('cancelling the order tells the kitchen to stop', async () => {
      const order = (await saveOrder(s.owner, { items: [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)] })).body;
      await fire(s.owner, order.id).expect(200);
      await s.owner.post('/orders/' + order.id + '/cancel', { reason: 'Customer left' }).expect(200);
      const cancels = (await tickets()).filter((kot) => kot.type === 'CANCEL');
      expect(cancels.map((kot) => [kot.stationName, kot.notes, kot.items[0]!.quantity])).toEqual([['Main Kitchen', 'Customer left', 2], ['Bar', 'Customer left', 1]]);
    });

    it('merging orders brings their tickets along; deleting an order removes them', async () => {
      const first = (await saveOrder(s.owner, { items: [line(s.menu.paneer.id, 1)] })).body;
      const second = (await saveOrder(s.owner, { items: [line(s.menu.cola.id, 1)] })).body;
      await fire(s.owner, first.id).expect(200);
      await fire(s.owner, second.id).expect(200);
      await s.owner.post('/orders/' + first.id + '/merge', { sourceOrderId: second.id }).expect(200);
      expect((await tickets('?orderId=' + first.id)).map((kot) => kot.stationName)).toEqual(['Main Kitchen', 'Bar']);
      expect((await tickets()).every((kot) => kot.orderDisplayNumber === 'A1-1')).toBe(true);

      await s.owner.post('/orders/' + first.id + '/delete', { reason: 'Test order' }).expect(200);
      expect(await tickets()).toEqual([]);
    });
  });

  describe('the kitchen display', () => {
    const one = async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1), line(s.menu.cola.id, 1)] })).body;
      const [food, drinks] = (await fire(s.cashier, order.id)).body as Kot[];
      return { order, food: food!, drinks: drinks! };
    };

    it('moves a ticket through preparing, ready and done, stamping each step', async () => {
      const { food } = await one();
      const status = (value: string) => kitchen.patch('/kots/' + food.id + '/status', { status: value });

      const preparing = (await status('PREPARING').expect(200)).body as Kot;
      expect(preparing).toMatchObject({ status: 'PREPARING', readyAt: null, completedAt: null });
      expect(preparing.preparingAt).not.toBeNull();
      const ready = (await status('READY').expect(200)).body as Kot;
      expect(ready.readyAt).not.toBeNull();
      const done = (await status('COMPLETED').expect(200)).body as Kot;
      expect(done).toMatchObject({ status: 'COMPLETED' });
      expect(done.completedAt).not.toBeNull();

      // A ticket marked done by mistake can be brought back.
      expect((await status('PREPARING').expect(200)).body).toMatchObject({ status: 'PREPARING', completedAt: null, readyAt: null });
      expect((await status('COOKED')).status).toBe(400);
    });

    it('shows active tickets by default, by station, and everything for today on request', async () => {
      const { food } = await one();
      await kitchen.patch('/kots/' + food.id + '/status', { status: 'COMPLETED' }).expect(200);
      expect((await tickets()).map((kot) => kot.stationName)).toEqual(['Bar']);
      expect((await tickets('?scope=today')).map((kot) => kot.stationName)).toEqual(['Main Kitchen', 'Bar']);
      expect(await tickets('?stationId=' + s.fx.station.id)).toEqual([]);
      expect((await tickets('?stationId=' + barId)).map((kot) => kot.items[0]!.name)).toEqual(['Cola']);
    });

    it('lets only kitchen roles change status; a cancellation ticket can only be acknowledged', async () => {
      const { order, food } = await one();
      expect((await s.cashier.patch('/kots/' + food.id + '/status', { status: 'READY' })).status).toBe(403);
      await s.cashier.get('/kots').expect(200); // the counter may look

      await s.owner.post('/orders/' + order.id + '/cancel', { reason: 'Left' }).expect(200);
      const cancel = (await tickets()).find((kot) => kot.type === 'CANCEL')!;
      expect((await kitchen.patch('/kots/' + cancel.id + '/status', { status: 'PREPARING' })).body.code).toBe('KOT_IS_CANCELLATION');
      await kitchen.patch('/kots/' + cancel.id + '/status', { status: 'COMPLETED' }).expect(200);
    });

    it('counts reprints of a ticket', async () => {
      const { food } = await one();
      expect((await s.cashier.post('/kots/' + food.id + '/printed').expect(200)).body.printCount).toBe(1);
      expect((await s.cashier.post('/kots/' + food.id + '/printed').expect(200)).body.printCount).toBe(2);
      expect(await h.prisma.auditLog.count({ where: { action: 'kot.reprinted' } })).toBe(1);
    });

    it('keeps tickets private to their restaurant', async () => {
      const { food } = await one();
      const other = await scene(h, 'b');
      expect((await other.owner.get('/kots').expect(200)).body).toEqual([]);
      expect((await other.owner.patch('/kots/' + food.id + '/status', { status: 'READY' })).status).toBe(404);
      // Each restaurant numbers its own tickets from 1.
      await h.prisma.product.update({ where: { id: other.menu.paneer.id }, data: { stationId: other.fx.station.id } });
      const theirs = (await saveOrder(other.owner, { items: [line(other.menu.paneer.id, 1)] })).body;
      expect(((await fire(other.owner, theirs.id)).body as Kot[])[0]!.kotNumber).toBe(1);
    });
  });

  describe('the floor', () => {
    it('adds, renames and removes areas', async () => {
      const terrace = (await s.owner.post('/areas', { name: 'Terrace' }).expect(201)).body;
      expect(terrace).toMatchObject({ name: 'Terrace', sortOrder: 1, tableCount: 0 });
      expect((await s.owner.post('/areas', { name: 'terrace' })).status).toBe(409);
      expect((await s.owner.patch('/areas/' + terrace.id, { name: 'Rooftop' }).expect(200)).body.name).toBe('Rooftop');
      expect((await s.cashier.get('/areas').expect(200)).body.map((area: { name: string; tableCount: number }) => [area.name, area.tableCount])).toEqual([['Main Hall', 2], ['Rooftop', 0]]);

      const hall = (await s.owner.get('/areas')).body[0];
      expect((await s.owner.delete('/areas/' + hall.id)).body.code).toBe('AREA_NOT_EMPTY');
      await s.owner.delete('/areas/' + terrace.id).expect(204);
      expect((await s.cashier.post('/areas', { name: 'Nope' })).status).toBe(403);
    });

    it('adds tables on a grid, edits them and saves a dragged layout', async () => {
      const areaId = (await s.owner.get('/areas')).body[0].id;
      const table = (await s.owner.post('/tables', { areaId, name: 'T9', seats: 6, shape: 'RECTANGLE' }).expect(201)).body;
      // The third table in the area takes the third grid slot.
      expect(table).toMatchObject({ name: 'T9', seats: 6, shape: 'RECTANGLE', status: 'FREE', posX: 360, posY: 40, width: 128, height: 96, orderId: null });
      expect((await s.owner.post('/tables', { areaId, name: 't9', seats: 2 })).status).toBe(409);
      expect((await s.owner.post('/tables', { areaId, name: 'Bad', seats: 0 })).status).toBe(400);

      const updated = (await s.owner.patch('/tables/' + table.id, { name: 'Booth 1', seats: 8, shape: 'ROUND' }).expect(200)).body;
      expect(updated).toMatchObject({ name: 'Booth 1', seats: 8, shape: 'ROUND' });

      const layout = await s.owner.put('/tables/layout', { tables: [{ id: table.id, posX: 640, posY: 320 }, { id: s.menu.t1.id, posX: 8, posY: 16 }] });
      expect(layout.status).toBe(200);
      const saved = (await s.cashier.get('/tables')).body as { id: string; posX: number; posY: number }[];
      expect(saved.find((t) => t.id === table.id)).toMatchObject({ posX: 640, posY: 320 });
      expect(saved.find((t) => t.id === s.menu.t1.id)).toMatchObject({ posX: 8, posY: 16 });

      const other = await scene(h, 'b');
      expect((await s.owner.put('/tables/layout', { tables: [{ id: other.menu.t1.id, posX: 0, posY: 0 }] })).body.code).toBe('LAYOUT_MISMATCH');
      expect((await s.owner.patch('/tables/' + other.menu.t1.id, { name: 'Mine' })).status).toBe(404);
    });

    it('blocks a table from taking orders, and will not block or remove a table in use', async () => {
      await s.owner.patch('/tables/' + s.menu.t2.id, { blocked: true }).expect(200);
      expect((await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t2.id, items: [] })).body.code).toBe('TABLE_BLOCKED');
      expect((await s.owner.patch('/tables/' + s.menu.t2.id, { blocked: false }).expect(200)).body.status).toBe('FREE');

      await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] }).expect(200);
      expect((await s.owner.patch('/tables/' + s.menu.t1.id, { blocked: true })).body.code).toBe('TABLE_IN_USE');
      expect((await s.owner.delete('/tables/' + s.menu.t1.id)).body.code).toBe('TABLE_IN_USE');

      // A removed table disappears from the floor and its name can be used again.
      await s.owner.delete('/tables/' + s.menu.t2.id).expect(204);
      expect((await s.cashier.get('/tables')).body.map((t: { name: string }) => t.name)).toEqual(['T1']);
      const areaId = (await s.owner.get('/areas')).body[0].id;
      await s.owner.post('/tables', { areaId, name: 'T2', seats: 4 }).expect(201);
    });

    it('shows the running order and its total on each table', async () => {
      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 2)] })).body;
      const table = ((await s.cashier.get('/pos/bootstrap')).body.tables as { name: string }[]).find((t) => t.name === 'T1');
      expect(table).toMatchObject({ status: 'OCCUPIED', orderId: order.id, orderDisplayNumber: 'A1-1', orderTotalPaise: 54600 });
    });

    it('moves a running order to another free table', async () => {
      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] })).body;
      await fire(s.cashier, order.id).expect(200);
      const moved = await s.cashier.post('/orders/' + order.id + '/transfer', { tableId: s.menu.t2.id });
      expect(moved.status).toBe(200);
      expect(moved.body.tableName).toBe('T2');
      const status = async (id: string) => (await h.prisma.diningTable.findUniqueOrThrow({ where: { id } })).status;
      expect([await status(s.menu.t1.id), await status(s.menu.t2.id)]).toEqual(['FREE', 'OCCUPIED']);
      // The kitchen sees the new table on the ticket.
      expect((await tickets())[0]!.tableName).toBe('T2');

      const second = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id, 1)] })).body;
      expect((await s.cashier.post('/orders/' + second.id + '/transfer', { tableId: s.menu.t2.id })).body.code).toBe('TABLE_OCCUPIED');
      const takeaway = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 1)] })).body;
      expect((await s.cashier.post('/orders/' + takeaway.id + '/transfer', { tableId: s.menu.t2.id })).body.code).toBe('ORDER_NOT_AT_TABLE');
      expect((await kitchen.post('/orders/' + order.id + '/transfer', { tableId: s.menu.t1.id })).status).toBe(403);
    });

    it('keeps a billed order\'s table marked as bill printed after a move', async () => {
      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] })).body;
      await s.cashier.post('/orders/' + order.id + '/invoices', {}).expect(201);
      await s.cashier.post('/orders/' + order.id + '/transfer', { tableId: s.menu.t2.id }).expect(200);
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t2.id } })).status).toBe('BILL_PRINTED');
    });
  });

  describe('live notices', () => {
    const sockets: Socket[] = [];
    afterEach(() => {
      for (const socket of sockets.splice(0)) socket.disconnect();
    });

    /** Connects a screen and collects every notice it receives. */
    async function connect(token: string | null): Promise<{ socket: Socket; events: [string, Record<string, unknown>][]; error: string | null }> {
      const socket = io(await h.listen(), { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      const events: [string, Record<string, unknown>][] = [];
      socket.onAny((event: string, payload: Record<string, unknown>) => events.push([event, payload]));
      const error = await new Promise<string | null>((resolve) => {
        socket.once('connect', () => resolve(null));
        socket.once('connect_error', (failure) => resolve(failure.message));
      });
      return { socket, events, error };
    }
    const until = async (check: () => boolean) => {
      for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 40));
      return check();
    };

    it('tells kitchen and billing screens when an order is sent, without telling other restaurants', async () => {
      const other = await scene(h, 'b');
      const kds = await connect(kitchen.token);
      const outsider = await connect(other.owner.token);
      expect([kds.error, outsider.error]).toEqual([null, null]);

      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] })).body;
      const [kot] = (await fire(s.cashier, order.id)).body as Kot[];

      expect(await until(() => kds.events.some(([event]) => event === 'kot.created'))).toBe(true);
      const created = kds.events.find(([event]) => event === 'kot.created')!;
      expect(created[1]).toEqual({ kotId: kot!.id, stationId: s.fx.station.id, orderId: order.id });
      expect(kds.events.map(([event]) => event)).toEqual(expect.arrayContaining(['order.updated', 'table.updated']));

      await kitchen.patch('/kots/' + kot!.id + '/status', { status: 'READY' }).expect(200);
      expect(await until(() => kds.events.some(([event]) => event === 'kot.updated'))).toBe(true);
      expect(outsider.events).toEqual([]);
    });

    it('tells billing screens when the menu or a bill changes', async () => {
      const pos = await connect(s.cashier.token);
      await s.cashier.patch('/products/' + s.menu.paneer.id + '/availability', { isAvailable: false }).expect(200);
      expect(await until(() => pos.events.some(([event]) => event === 'menu.updated'))).toBe(true);

      const { invoice } = await billed(s.cashier, [line(s.menu.cola.id, 1)]);
      expect(await until(() => pos.events.some(([event, payload]) => event === 'invoice.updated' && payload.invoiceId === invoice.id))).toBe(true);
      // Reading never raises a notice.
      const before = pos.events.length;
      await s.cashier.get('/products').expect(200);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(pos.events.length).toBe(before);
    });

    it('refuses a screen without a valid, live session', async () => {
      expect((await connect(null)).error).toBe('UNAUTHORIZED');
      expect((await connect('not-a-token')).error).toBe('UNAUTHORIZED');
      const token = s.cashier.token;
      await s.cashier.post('/auth/logout', { client: 'pos' }).expect(204);
      expect((await connect(token)).error).toBe('UNAUTHORIZED');
    });
  });
});
