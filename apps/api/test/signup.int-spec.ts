import { randomUUID } from 'node:crypto';
import { line, scene } from './support/billing.js';
import { createHarness, type Harness, mailbox, PASSWORD } from './support/harness.js';

const DAY = 86_400_000;
const NEW_PASSWORD = 'tandoori nights 42';
const tokenIn = (text: string) => /token=([\w-]+)/.exec(text)![1]!;

/** A restaurant registering itself, confirming its email, and what it gets. */
describe('sign-up', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    await mailbox.clear();
  });
  afterAll(async () => {
    await mailbox.clear();
    await h.close();
  });

  const details = (extra: object = {}) => ({
    restaurantName: 'Spice Garden', ownerName: 'Meera Nair', email: 'meera@test.local', password: NEW_PASSWORD, phone: '9876543210',
    stateCode: '32', gstRegistration: 'REGULAR', gstin: '32ABCDE1234F1Z5', ...extra,
  });
  const signup = (body: object = details()) => h.client().post('/signup', body);
  /** Registers and opens the emailed link. Returns a signed-in back-office client. */
  async function registered(body: ReturnType<typeof details> = details()) {
    await signup(body).expect(202);
    const mail = await mailbox.latestTo(body.email);
    await h.client().post('/signup/verify', { token: tokenIn(mail!.text) }).expect(200);
    const client = h.client();
    expect((await client.login(body.email, body.password)).status).toBe(200);
    return client;
  }

  it('creates a restaurant that is ready to bill once the owner confirms their email', async () => {
    expect((await h.client().get('/signup/options').expect(200)).body).toEqual({ enabled: true, trialDays: 14 });
    await signup().expect(202);

    // Nobody can sign in until the address is confirmed.
    const early = await h.client().login('meera@test.local', NEW_PASSWORD);
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('EMAIL_NOT_VERIFIED');
    // A wrong password still says only that, and nothing about the account.
    expect((await h.client().login('meera@test.local', 'not the password')).body.code).toBe('INVALID_CREDENTIALS');

    const mail = await mailbox.latestTo('meera@test.local');
    expect(mail!.subject).toContain('Confirm your email');
    expect(mail!.text).toContain('14-day free trial');
    const verified = await h.client().post('/signup/verify', { token: tokenIn(mail!.text) }).expect(200);
    expect(verified.body).toEqual({ email: 'meera@test.local' });
    // The link works once.
    expect((await h.client().post('/signup/verify', { token: tokenIn(mail!.text) })).body.code).toBe('VERIFY_LINK_INVALID');

    const owner = h.client();
    const login = await owner.login('meera@test.local', NEW_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ name: 'Meera Nair', restaurantName: 'Spice Garden', role: { key: 'owner' } });
    expect(login.body.user.permissions).toContain('settings.manage');

    const restaurant = (await owner.get('/restaurant').expect(200)).body;
    expect(restaurant).toMatchObject({ name: 'Spice Garden', stateCode: '32', stateName: 'Kerala', gstin: '32ABCDE1234F1Z5', phone: '9876543210' });
    expect(restaurant.subscription).toMatchObject({ status: 'TRIAL', paidUntil: null });
    expect([13, 14]).toContain(restaurant.subscription.daysLeft);
    expect((await owner.get('/settings').expect(200)).body).toMatchObject({ gstRegistration: 'REGULAR', registerRequired: false });
    expect((await owner.get('/tax-groups').expect(200)).body.map((group: { name: string }) => group.name).sort()).toEqual(['GST 0%', 'GST 12%', 'GST 18%', 'GST 5%']);
    expect((await owner.get('/terminals').expect(200)).body).toEqual([expect.objectContaining({ code: 'A1', name: 'Counter 1', isActive: true })]);
    expect((await owner.get('/stations').expect(200)).body).toEqual([expect.objectContaining({ name: 'Kitchen' })]);
    expect((await owner.get('/roles').expect(200)).body.map((role: { key: string }) => role.key).sort()).toEqual(['captain', 'cashier', 'kitchen', 'manager', 'owner']);
    expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'restaurant.created' } })).after).toMatchObject({ via: 'sign-up', trialDays: 14 });

    // And it really bills: a category, a product, an order, bill number one of its own series.
    const category = (await owner.post('/categories', { name: 'Mains' }).expect(201)).body;
    const product = (await owner.post('/products', { name: 'Fish Curry', categoryId: category.id, basePricePaise: 30000 }).expect(201)).body;
    const terminal = (await owner.get('/terminals').expect(200)).body[0];
    const till = h.client();
    await till.loginPos('meera@test.local', NEW_PASSWORD, { terminalId: terminal.id });
    const order = (await till.put('/orders/' + randomUUID(), { type: 'TAKEAWAY', items: [line(product.id, 2)] }).expect(200)).body;
    const [invoice] = (await till.post('/orders/' + order.id + '/invoices', {}).expect(201)).body;
    expect(invoice).toMatchObject({ invoiceNumber: expect.stringMatching(/^A1\/\d{4}\/000001$/), totalPaise: 63000 });
  });

  it('keeps a new restaurant apart from every other', async () => {
    const other = await scene(h);
    const owner = await registered();
    expect((await owner.get('/products').expect(200)).body.total).toBe(0);
    expect((await owner.get('/users').expect(200)).body.map((user: { email: string }) => user.email)).toEqual(['meera@test.local']);
    expect((await owner.get('/orders/' + randomUUID())).status).toBe(404);
    expect((await other.owner.get('/users').expect(200)).body.map((user: { email: string }) => user.email)).not.toContain('meera@test.local');
    expect(await h.prisma.restaurant.count()).toBe(2);
  });

  it('answers the same for an address that already has an account, and tells that person by email', async () => {
    const existing = await scene(h);
    const taken = await signup(details({ email: existing.fx.owner.email }));
    expect(taken.status).toBe(202);
    expect(taken.body).toEqual({});
    expect(await h.prisma.restaurant.count()).toBe(1);
    const mail = await mailbox.latestTo(existing.fx.owner.email);
    expect(mail!.subject).toContain('You already have a');
    expect(mail!.text).toContain('Test Restaurant A');
    expect(mail!.text).not.toContain('token=');
    // Their password is untouched.
    expect((await h.client().login(existing.fx.owner.email, PASSWORD)).status).toBe(200);
  });

  it('lets someone who never confirmed register again: the newest details win and only the newest link works', async () => {
    await signup().expect(202);
    const first = tokenIn((await mailbox.latestTo('meera@test.local'))!.text);
    await mailbox.clear();
    await signup(details({ restaurantName: 'Spice Garden Kochi', password: 'a different password 9', gstRegistration: 'UNREGISTERED', gstin: '' })).expect(202);
    const second = tokenIn((await mailbox.latestTo('meera@test.local'))!.text);

    expect(await h.prisma.restaurant.count()).toBe(1);
    expect((await h.client().post('/signup/verify', { token: first })).status).toBe(400);
    await h.client().post('/signup/verify', { token: second }).expect(200);
    expect((await h.client().login('meera@test.local', NEW_PASSWORD)).status).toBe(401);
    const owner = h.client();
    expect((await owner.login('meera@test.local', 'a different password 9')).status).toBe(200);
    expect((await owner.get('/restaurant').expect(200)).body).toMatchObject({ name: 'Spice Garden Kochi', gstin: null });
    expect((await owner.get('/settings').expect(200)).body.gstRegistration).toBe('UNREGISTERED');
  });

  it('checks what is entered, and sends the link again on request', async () => {
    expect((await signup(details({ gstin: '' }))).status).toBe(400);
    expect((await signup(details({ gstin: '27ABCDE1234F1Z5' }))).status).toBe(400);
    expect((await signup(details({ password: 'short' }))).status).toBe(400);
    expect((await signup(details({ phone: '12345' }))).status).toBe(400);
    expect(await h.prisma.restaurant.count()).toBe(0);
    await h.redis.flushdb();

    await signup().expect(202);
    await mailbox.clear();
    await h.client().post('/signup/resend', { email: 'meera@test.local' }).expect(202);
    const again = await mailbox.latestTo('meera@test.local');
    await h.client().post('/signup/verify', { token: tokenIn(again!.text) }).expect(200);

    // Nothing is sent to an address that is unknown, or already confirmed; the answer is the same.
    await mailbox.clear();
    await h.client().post('/signup/resend', { email: 'meera@test.local' }).expect(202);
    await h.client().post('/signup/resend', { email: 'nobody@test.local' }).expect(202);
    expect(await mailbox.list()).toEqual([]);
    expect((await h.client().post('/signup/verify', { token: 'x'.repeat(43) })).body.code).toBe('VERIFY_LINK_INVALID');
  });

  it('refuses a link that has expired, and a sixth registration from one address within the hour', async () => {
    await signup().expect(202);
    await h.prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const mail = await mailbox.latestTo('meera@test.local');
    expect((await h.client().post('/signup/verify', { token: tokenIn(mail!.text) })).body.code).toBe('VERIFY_LINK_INVALID');

    for (let attempt = 2; attempt <= 5; attempt += 1) await signup(details({ email: `owner${attempt}@test.local` })).expect(202);
    expect((await signup(details({ email: 'owner6@test.local' }))).status).toBe(429);
  });

  it('shows what is left to set up, and hides the list when the owner says so', async () => {
    const owner = await registered();
    const steps = async () => (await owner.get('/onboarding').expect(200)).body;
    expect(await steps()).toEqual({ dismissed: false, steps: { details: false, menu: false, tables: false, staff: false, firstBill: false } });

    await owner.patch('/restaurant', { addressLine1: '12 Beach Road', city: 'Kochi' }).expect(200);
    const category = (await owner.post('/categories', { name: 'Mains' }).expect(201)).body;
    await owner.post('/products', { name: 'Fish Curry', categoryId: category.id, basePricePaise: 30000 }).expect(201);
    expect((await steps()).steps).toEqual({ details: true, menu: true, tables: false, staff: false, firstBill: false });

    expect((await owner.post('/onboarding/dismiss').expect(200)).body.dismissed).toBe(true);
    expect((await steps()).dismissed).toBe(true);
    // A restaurant that existed before sign-up was built never sees the list.
    const old = await scene(h, 'b');
    expect((await old.cashier.post('/onboarding/dismiss')).status).toBe(403);
  });

  it('lets a restaurant whose trial has ended look at everything and change nothing', async () => {
    const owner = await registered();
    const category = (await owner.post('/categories', { name: 'Mains' }).expect(201)).body;
    const restaurant = await h.prisma.restaurant.findFirstOrThrow();
    await h.prisma.restaurant.update({ where: { id: restaurant.id }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    await h.redis.flushdb();

    expect((await owner.get('/restaurant').expect(200)).body.subscription).toMatchObject({ status: 'EXPIRED', daysLeft: 0 });
    expect((await owner.get('/categories').expect(200)).body).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    expect((await owner.get('/reports/sales-daily/export?from=' + today + '&to=' + today + '&format=csv')).status).toBe(200);
    for (const attempt of [owner.post('/categories', { name: 'Desserts' }), owner.patch('/categories/' + category.id, { name: 'Curries' }), owner.delete('/categories/' + category.id)]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SUBSCRIPTION_EXPIRED');
    }
    expect(await h.prisma.category.count()).toBe(1);
    // Signing in and out still work, so nobody is locked out of their own records.
    expect((await h.client().login('meera@test.local', NEW_PASSWORD)).status).toBe(200);
    expect((await owner.post('/auth/logout', { client: 'web' })).status).toBeLessThan(300);

    // Paid up to today: everything works again.
    await h.prisma.restaurant.update({ where: { id: restaurant.id }, data: { paidUntil: new Date(today + 'T00:00:00Z') } });
    await h.redis.flushdb();
    const back = h.client();
    await back.login('meera@test.local', NEW_PASSWORD);
    expect((await back.get('/restaurant').expect(200)).body.subscription).toMatchObject({ status: 'ACTIVE', paidUntil: today, daysLeft: 0 });
    await back.post('/categories', { name: 'Desserts' }).expect(201);
  });

  it('is closed when the vendor switches registration off', async () => {
    const { env } = await import('../src/config/env.js');
    (env as { SIGNUP_ENABLED: boolean }).SIGNUP_ENABLED = false;
    try {
      const refused = await signup();
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SIGNUP_CLOSED');
      expect((await h.client().get('/signup/options').expect(200)).body.enabled).toBe(false);
      expect(await h.prisma.restaurant.count()).toBe(0);
    } finally {
      (env as { SIGNUP_ENABLED: boolean }).SIGNUP_ENABLED = true;
    }
  });
});
