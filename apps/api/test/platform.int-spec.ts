import argon2 from 'argon2';
import { billed, line, pay, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, mailbox, ORIGIN, PASSWORD } from './support/harness.js';

const ADMIN_ORIGIN = 'http://admin.test';
const ADMIN = { email: 'admin@test.local', password: 'platform admin secret 1' };
const DAY = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/** The vendor's admin app: its own sign-in, and what it can do to restaurants. */
describe('platform admin', () => {
  let h: Harness;
  let s: Scene;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    await mailbox.clear();
    s = await scene(h);
    await h.prisma.platformAdmin.create({
      data: { name: 'Asha (support)', email: ADMIN.email, passwordHash: await argon2.hash(ADMIN.password, { type: argon2.argon2id, memoryCost: 1024, timeCost: 2 }) },
    });
  });
  afterAll(async () => {
    await mailbox.clear();
    await h.close();
  });

  /** A browser on the admin app: keeps the platform cookie and sends the admin app's origin. */
  function adminBrowser(origin = ADMIN_ORIGIN) {
    const { agent } = h.client();
    const prefix = '/api/v1/platform';
    return {
      get: (path: string) => agent.get(prefix + path).set('Origin', origin),
      post: (path: string, body?: object) => agent.post(prefix + path).set('Origin', origin).send(body),
      put: (path: string, body?: object) => agent.put(prefix + path).set('Origin', origin).send(body),
    };
  }
  async function signedIn() {
    const browser = adminBrowser();
    await browser.post('/login', ADMIN).expect(200);
    return browser;
  }
  const restaurantId = () => s.fx.restaurant.id;
  const audit = (action: string) => h.prisma.auditLog.findFirstOrThrow({ where: { action, restaurantId: restaurantId() } });

  describe('signing in', () => {
    it('is its own kind of account, with a session cookie only the platform routes ever see', async () => {
      const browser = adminBrowser();
      expect((await browser.get('/me')).status).toBe(401);
      const login = await browser.post('/login', ADMIN);
      expect(login.status).toBe(200);
      expect(login.body).toEqual({ id: expect.any(String), name: 'Asha (support)', email: ADMIN.email });
      const cookie = String(login.headers['set-cookie']);
      expect(cookie).toMatch(/^pos_platform=/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/api/v1/platform');
      // Only a hash of the session is kept.
      const token = /pos_platform=([^;]+)/.exec(cookie)![1]!;
      expect((await h.prisma.platformSession.findFirstOrThrow()).tokenHash).not.toContain(token);
      expect((await browser.get('/me').expect(200)).body.email).toBe(ADMIN.email);

      await browser.post('/logout').expect(204);
      expect((await browser.get('/me')).status).toBe(401);
      expect(await h.prisma.platformSession.count()).toBe(0);
    });

    it('opens nothing for a restaurant sign-in, and a platform session opens nothing in a restaurant', async () => {
      const browser = await signedIn();
      // The owner of a restaurant, with a valid token, from the admin app's address.
      const asOwner = await h.client().agent.get('/api/v1/platform/restaurants').set('Origin', ADMIN_ORIGIN).set('Authorization', 'Bearer ' + s.owner.token);
      expect(asOwner.status).toBe(401);
      // The platform cookie is not sent to restaurant routes, and would not be accepted there.
      const login = await adminBrowser().post('/login', ADMIN);
      const cookie = /pos_platform=[^;]+/.exec(String(login.headers['set-cookie']))![0];
      expect((await h.client().agent.get('/api/v1/users').set('Origin', ORIGIN).set('Cookie', cookie)).status).toBe(401);
      // A restaurant user's email and password do not sign in here.
      expect((await adminBrowser().post('/login', { email: s.fx.owner.email, password: PASSWORD })).status).toBe(401);
      expect((await h.client().login(ADMIN.email, ADMIN.password)).status).toBe(401);
      expect((await browser.get('/overview')).status).toBe(200);
    });

    it('is refused from any other site, even with the cookie', async () => {
      const login = await adminBrowser().post('/login', ADMIN).expect(200);
      const cookie = /pos_platform=[^;]+/.exec(String(login.headers['set-cookie']))![0];
      for (const origin of [ORIGIN, 'http://evil.test']) {
        expect((await h.client().agent.get('/api/v1/platform/restaurants').set('Origin', origin).set('Cookie', cookie)).status).toBe(403);
        expect((await h.client().agent.post('/api/v1/platform/restaurants/' + restaurantId() + '/suspend').set('Origin', origin).set('Cookie', cookie).send({ reason: 'x' })).status).toBe(403);
        expect((await h.client().agent.post('/api/v1/platform/login').set('Origin', origin).send(ADMIN)).status).toBe(403);
      }
      // No Origin at all (not a browser) is refused too.
      expect((await h.client().agent.get('/api/v1/platform/restaurants').set('Cookie', cookie)).status).toBe(403);
      expect((await h.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId() } })).isActive).toBe(true);
    });

    it('locks after five wrong passwords, and ends a session that sits unused', async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await h.redis.flushdb();
        expect((await adminBrowser().post('/login', { ...ADMIN, password: 'wrong' })).status).toBe(401);
      }
      await h.redis.flushdb();
      const locked = await adminBrowser().post('/login', ADMIN);
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      await h.prisma.platformAdmin.updateMany({ data: { lockedUntil: null } });

      const browser = await signedIn();
      await h.prisma.platformSession.updateMany({ data: { lastUsedAt: new Date(Date.now() - 121 * 60_000) } });
      expect((await browser.get('/me')).status).toBe(401);
      const again = await signedIn();
      await h.prisma.platformSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await again.get('/me')).status).toBe(401);
      // Too many attempts from one address are slowed down whatever the password.
      for (let attempt = 1; attempt <= 5; attempt += 1) await adminBrowser().post('/login', { ...ADMIN, password: 'wrong' });
      expect((await adminBrowser().post('/login', ADMIN)).status).toBe(429);
    });
  });

  describe('restaurants', () => {
    it('lists every restaurant with its owner, subscription and use, and finds, filters and sorts them', async () => {
      const other = await scene(h, 'b');
      await h.prisma.restaurant.update({ where: { id: other.fx.restaurant.id }, data: { trialEndsAt: new Date(Date.now() + 3 * DAY + 60_000), city: 'Pune' } });
      const { invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 2)]);
      await pay(s.cashier, invoice.id, [{ method: 'UPI', amountPaise: invoice.totalPaise }]).expect(200);
      const browser = await signedIn();

      const all = (await browser.get('/restaurants?sort=name&direction=asc').expect(200)).body;
      expect(all.total).toBe(2);
      expect(all.items[0]).toMatchObject({
        name: 'Test Restaurant A', ownerName: 'Owner', ownerEmail: 'owner-a@test.local', ownerVerified: true, createdVia: 'SEED', users: 2,
        subscription: { status: 'ACTIVE', daysLeft: null }, billsLast30Days: 1, salesLast30DaysPaise: 54600, suspendReason: null,
      });
      expect(all.items[0].lastActiveAt).toEqual(expect.any(String));
      expect(all.items[1]).toMatchObject({ name: 'Test Restaurant B', city: 'Pune', subscription: { status: 'TRIAL', daysLeft: 3 }, billsLast30Days: 0 });
      // Nothing about a restaurant's bills, customers or passwords comes with it.
      expect(JSON.stringify(all)).not.toMatch(/passwordHash|pinHash|invoiceNumber/);

      const names = async (query: string) => (await browser.get('/restaurants?' + query).expect(200)).body.items.map((row: { name: string }) => row.name);
      expect(await names('search=pune')).toEqual(['Test Restaurant B']);
      expect(await names('search=OWNER-A@')).toEqual(['Test Restaurant A']);
      expect(await names('status=TRIAL')).toEqual(['Test Restaurant B']);
      expect(await names('status=SUSPENDED')).toEqual([]);
      expect(await names('sort=bills&direction=desc')).toEqual(['Test Restaurant A', 'Test Restaurant B']);
      // A has no end date, so it comes last whichever way the column is sorted.
      expect(await names('sort=ends&direction=asc')).toEqual(['Test Restaurant B', 'Test Restaurant A']);
      expect(await names('sort=ends&direction=desc')).toEqual(['Test Restaurant B', 'Test Restaurant A']);
      expect(await names('pageSize=1&page=2&sort=name&direction=asc')).toEqual(['Test Restaurant B']);
      expect((await browser.get('/restaurants?sort=password')).status).toBe(400);

      expect((await browser.get('/overview').expect(200)).body).toEqual({
        restaurants: { total: 2, ACTIVE: 1, TRIAL: 1, EXPIRED: 0, SUSPENDED: 0 }, signupsLast30Days: 2,
        trialsEndingSoon: [{ id: other.fx.restaurant.id, name: 'Test Restaurant B', trialEndsAt: expect.any(String), daysLeft: 3 }],
      });
    });

    it('opens one restaurant for support and records that it was looked at', async () => {
      const browser = await signedIn();
      const detail = (await browser.get('/restaurants/' + restaurantId()).expect(200)).body;
      expect(detail).toMatchObject({ name: 'Test Restaurant A', gstin: '27AAAAA0000A1Z5', gstRegistration: 'REGULAR', terminals: 1, products: 4, billsTotal: 0 });
      expect(detail.people.map((person: { name: string; roleName: string }) => [person.name, person.roleName])).toEqual([['Owner', 'Owner'], ['Cashier', 'Cashier']]);
      expect(detail.activity[0]).toMatchObject({ action: 'auth.login' });
      expect(JSON.stringify(detail)).not.toMatch(/passwordHash|pinHash/);

      // Written into the restaurant's own audit log, once an hour however often the page is opened.
      await browser.get('/restaurants/' + restaurantId()).expect(200);
      const views = await h.prisma.auditLog.findMany({ where: { action: 'platform.support_viewed' } });
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ restaurantId: restaurantId(), userId: null, after: { platformAdmin: 'Asha (support) <admin@test.local>' } });
      expect((await browser.get('/restaurants/8b6f3f0e-1111-4222-8333-444455556666')).status).toBe(404);
    });

    it('sets a restaurant up for someone, who chooses a password through the emailed link', async () => {
      const browser = await signedIn();
      const body = { restaurantName: 'Dosa Corner', ownerName: 'Ravi Kumar', email: 'ravi@test.local', stateCode: '29', gstRegistration: 'UNREGISTERED', trialDays: 30 };
      expect((await browser.post('/restaurants', { ...body, gstRegistration: 'REGULAR' })).status).toBe(400);
      expect((await browser.post('/restaurants', { ...body, email: s.fx.cashier.email })).body.code).toBe('EMAIL_TAKEN');

      const created = (await browser.post('/restaurants', body).expect(201)).body;
      expect(created).toMatchObject({
        name: 'Dosa Corner', stateName: 'Karnataka', ownerName: 'Ravi Kumar', ownerEmail: 'ravi@test.local', ownerVerified: false, createdVia: 'PLATFORM',
        gstRegistration: 'UNREGISTERED', terminals: 1, subscription: { status: 'TRIAL' },
      });
      expect([29, 30]).toContain(created.subscription.daysLeft);
      expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'restaurant.created' } })).after).toMatchObject({ via: 'platform', platformAdmin: expect.stringContaining('admin@test.local') });

      const mail = await mailbox.latestTo('ravi@test.local');
      expect(mail!.subject).toContain('choose your password');
      expect(mail!.text).toContain('Dosa Corner');
      const token = /token=([\w-]+)/.exec(mail!.text)![1]!;
      // Until the link is used there is no way in.
      expect((await h.client().login('ravi@test.local', 'anything at all 123')).status).toBe(401);
      await h.client().post('/auth/reset-password', { token, password: 'crispy masala dosa 7' }).expect(204);
      const owner = h.client();
      expect((await owner.login('ravi@test.local', 'crispy masala dosa 7')).status).toBe(200);
      expect((await owner.get('/restaurant').expect(200)).body.name).toBe('Dosa Corner');
      // Using the link is what confirmed the address.
      expect((await browser.get('/restaurants/' + created.id).expect(200)).body.ownerVerified).toBe(true);

      // With no trial, the restaurant has no time limit until one is set.
      const open = (await browser.post('/restaurants', { ...body, restaurantName: 'Idli House', email: 'latha@test.local', trialDays: 0 }).expect(201)).body;
      expect(open.subscription).toMatchObject({ status: 'ACTIVE', daysLeft: null });

      // Support can send a locked-out owner a fresh link at any time.
      await mailbox.clear();
      await browser.post('/restaurants/' + created.id + '/invite').expect(204);
      expect((await mailbox.latestTo('ravi@test.local'))!.subject).toContain('Choose a new');
    });

    it('suspends a restaurant at once and restores it, saying who and why in its audit log', async () => {
      const browser = await signedIn();
      expect((await browser.post('/restaurants/' + restaurantId() + '/suspend', {})).status).toBe(400);
      const suspended = (await browser.post('/restaurants/' + restaurantId() + '/suspend', { reason: 'Chargeback on the subscription payment' }).expect(200)).body;
      expect(suspended).toMatchObject({ subscription: { status: 'SUSPENDED' }, suspendReason: 'Chargeback on the subscription payment' });
      expect((await browser.post('/restaurants/' + restaurantId() + '/suspend', { reason: 'Again' })).body.code).toBe('ALREADY_SUSPENDED');

      // People already signed in are stopped on their next request, at the till and in the back office.
      expect((await s.cashier.get('/orders/running')).status).toBe(401);
      expect((await s.owner.get('/restaurant')).status).toBe(401);
      const login = await h.client().login(s.fx.owner.email, PASSWORD);
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('RESTAURANT_SUSPENDED');
      // Still nothing about the account for someone who does not know the password.
      expect((await h.client().login(s.fx.owner.email, 'wrong password')).body.code).toBe('INVALID_CREDENTIALS');
      expect(await audit('platform.suspended')).toMatchObject({ reason: 'Chargeback on the subscription payment', userId: null, after: { platformAdmin: 'Asha (support) <admin@test.local>' } });

      const restored = (await browser.post('/restaurants/' + restaurantId() + '/reactivate').expect(200)).body;
      expect(restored).toMatchObject({ subscription: { status: 'ACTIVE' }, suspendReason: null });
      expect((await browser.post('/restaurants/' + restaurantId() + '/reactivate')).body.code).toBe('NOT_SUSPENDED');
      const back = h.client();
      expect((await back.login(s.fx.owner.email, PASSWORD)).status).toBe(200);
      // Nothing was lost while it was suspended.
      expect((await back.get('/products').expect(200)).body.total).toBe(4);
      expect((await audit('platform.reactivated')).before).toMatchObject({ suspendReason: 'Chargeback on the subscription payment' });
    });

    it('sets how long a restaurant may be used: a trial end, then a paid period', async () => {
      const browser = await signedIn();
      const path = '/restaurants/' + restaurantId();
      // A trial that ended yesterday: the restaurant can look but not change.
      const ended = (await browser.put(path + '/trial', { trialEndsOn: isoDay(-1), note: 'Trial was only meant to be a week' }).expect(200)).body;
      expect(ended.subscription).toMatchObject({ status: 'EXPIRED' });
      expect((await s.owner.get('/products').expect(200)).body.total).toBe(4);
      const refused = await s.owner.post('/categories', { name: 'Desserts' });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SUBSCRIPTION_EXPIRED');

      // More time, effective immediately.
      const extended = (await browser.put(path + '/trial', { trialEndsOn: isoDay(10), note: 'Owner asked for two more weeks' }).expect(200)).body;
      expect(extended.subscription.status).toBe('TRIAL');
      expect([9, 10]).toContain(extended.subscription.daysLeft);
      await s.owner.post('/categories', { name: 'Desserts' }).expect(201);
      expect(await audit('platform.trial_changed')).toMatchObject({ reason: expect.any(String), after: { platformAdmin: expect.stringContaining('Asha') } });

      // Paid for a year, recorded by hand with how it was paid.
      expect((await browser.put(path + '/paid-until', { paidUntil: isoDay(365) })).status).toBe(400);
      const paid = (await browser.put(path + '/paid-until', { paidUntil: isoDay(365), note: 'UPI ref 4411, ₹12,000 for one year' }).expect(200)).body;
      expect(paid.subscription).toMatchObject({ status: 'ACTIVE', paidUntil: isoDay(365) });
      expect([364, 365, 366]).toContain(paid.subscription.daysLeft);
      const entries = await h.prisma.auditLog.findMany({ where: { action: 'platform.paid_until_changed' } });
      expect(entries[0]).toMatchObject({ reason: 'UPI ref 4411, ₹12,000 for one year', before: { paidUntil: null }, after: { paidUntil: isoDay(365) } });

      // The paid period removed and the trial long over: read-only again.
      await browser.put(path + '/trial', { trialEndsOn: isoDay(-5), note: 'Correcting the record' }).expect(200);
      const lapsed = (await browser.put(path + '/paid-until', { paidUntil: null, note: 'Payment bounced' }).expect(200)).body;
      expect(lapsed.subscription.status).toBe('EXPIRED');
      expect((await s.owner.post('/categories', { name: 'Drinks' })).body.code).toBe('SUBSCRIPTION_EXPIRED');
      expect((await browser.put(path + '/trial', { trialEndsOn: '2026-02-30', note: 'Bad date' })).status).toBe(400);
    });
  });
});
