import request from 'supertest';
import { CASHIER_PIN, createHarness, type Fixture, type Harness, mailbox, ORIGIN, OWNER_PIN, PASSWORD, seedRestaurant } from './support/harness.js';

describe('authentication', () => {
  let h: Harness;
  let fx: Fixture;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    fx = await seedRestaurant(h.prisma);
  });
  afterAll(async () => {
    await mailbox.clear();
    await h.close();
  });

  const BROWSER = 'Mozilla/5.0 (Linux; Android 14; SM-T220) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
  const refreshCookie = (response: request.Response, client = 'web'): string => {
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return cookies.find((cookie) => cookie.startsWith(`pos_rt_${client}=`))!.split(';')[0]!;
  };

  describe('sign in', () => {
    it('returns an access token and sets an HttpOnly, SameSite=Strict refresh cookie', async () => {
      const client = h.client();
      const response = await client.login(fx.owner.email);

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({ email: fx.owner.email, role: { key: 'owner' }, restaurantId: fx.restaurant.id });
      expect(response.body.user.permissions).toContain('users.manage');
      expect(JSON.stringify(response.body)).not.toContain('refresh');
      const cookie = (response.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pos_rt_web='))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      await client.get('/auth/me').expect(200);
    });

    it('accepts the email in any letter case', async () => {
      await h.client().login(fx.owner.email.toUpperCase()).then((r) => expect(r.status).toBe(200));
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const wrong = await h.client().login(fx.owner.email, 'not the password');
      const unknown = await h.client().login('nobody@test.local', 'not the password');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect({ code: unknown.body.code, message: unknown.body.message }).toEqual({ code: wrong.body.code, message: wrong.body.message });
    });

    it('refuses an inactive user', async () => {
      await h.prisma.user.update({ where: { id: fx.cashier.id }, data: { isActive: false } });
      const response = await h.client().loginPos(fx.cashier.email);
      expect(response.status).toBe(401);
    });

    it('locks the account after five wrong passwords, even for the right password', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await h.client().loginPos(fx.cashier.email, 'wrong password')).status).toBe(401);
      }
      const locked = await h.client().loginPos(fx.cashier.email);
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');

      // Once the lock expires the right password works again.
      await h.prisma.user.update({ where: { id: fx.cashier.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      expect((await h.client().loginPos(fx.cashier.email)).status).toBe(200);
    });

    it('rate limits sign-in attempts per IP address', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        statuses.push((await h.client().login(`nobody${attempt}@test.local`, 'x')).status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('rejects requests without a token or with a forged one', async () => {
      const client = h.client();
      expect((await client.get('/auth/me')).status).toBe(401);
      client.token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged';
      expect((await client.get('/auth/me')).status).toBe(401);
    });

    it('binds the session to a terminal when one is given, and rejects an unknown terminal', async () => {
      const ok = await h.client().loginPos(fx.cashier.email, PASSWORD, { client: 'pos', terminalId: fx.terminal.id });
      expect(ok.body.user.terminalId).toBe(fx.terminal.id);
      const bad = await h.client().loginPos(fx.cashier.email, PASSWORD, { client: 'pos', terminalId: fx.owner.id });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('TERMINAL_NOT_FOUND');
    });
  });

  describe('billing-only accounts', () => {
    it('keeps a biller out of the back office but lets them in on the billing screen', async () => {
      const refused = await h.client().login(fx.cashier.email);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('BACKOFFICE_NOT_ALLOWED');
      expect(refused.body.message).toMatch(/billing only/);
      expect(refused.headers['set-cookie']).toBeUndefined();
      expect(await h.prisma.session.count({ where: { userId: fx.cashier.id } })).toBe(0);
      // Being turned away is not a failed password, so it never locks the account.
      expect((await h.prisma.user.findUniqueOrThrow({ where: { id: fx.cashier.id } })).failedLoginCount).toBe(0);
      // A wrong password is answered as usual, so the refusal tells a stranger nothing.
      expect((await h.client().login(fx.cashier.email, 'not the password')).body.code).toBe('INVALID_CREDENTIALS');

      const biller = h.client();
      const allowed = await biller.loginPos(fx.cashier.email);
      expect(allowed.status).toBe(200);
      expect(allowed.body.user.permissions).not.toContain('backoffice.access');
      expect(allowed.body.user.permissions).toContain('invoice.create');
      await biller.get('/auth/me').expect(200);
    });

    it('lets owners and managers in, and ends a back-office session once the role loses access', async () => {
      await h.prisma.user.update({ where: { id: fx.cashier.id }, data: { roleId: fx.roles.manager! } });
      const manager = h.client();
      expect((await manager.login(fx.cashier.email)).status).toBe(200);

      const owner = h.client();
      await owner.login(fx.owner.email);
      const role = ((await owner.get('/roles')).body as { id: string; key: string; permissions: string[] }[]).find((r) => r.key === 'manager')!;
      expect(role.permissions).toContain('backoffice.access');
      await owner.patch(`/roles/${role.id}`, { permissions: role.permissions.filter((key) => key !== 'backoffice.access') }).expect(200);

      const renewed = await manager.post('/auth/refresh', { client: 'web' });
      expect(renewed.status).toBe(403);
      expect(renewed.body.code).toBe('BACKOFFICE_NOT_ALLOWED');
      expect((await manager.get('/auth/me')).status).toBe(401);
      // The same person can still bill.
      expect((await h.client().loginPos(fx.cashier.email)).status).toBe(200);
    });
  });

  describe('refresh tokens', () => {
    it('rotates the refresh token and issues a working access token', async () => {
      const client = h.client();
      const login = await client.login(fx.owner.email);
      const refreshed = await client.post('/auth/refresh', { client: 'web' });

      expect(refreshed.status).toBe(200);
      expect(refreshCookie(refreshed)).not.toBe(refreshCookie(login));
      client.token = refreshed.body.accessToken;
      await client.get('/auth/me').expect(200);
    });

    it('ends the whole session when an already-used refresh token is presented again', async () => {
      const client = h.client();
      const login = await client.agent.post('/api/v1/auth/login').set('Origin', ORIGIN).set('User-Agent', BROWSER).send({ email: fx.owner.email, password: PASSWORD, client: 'web' });
      client.token = login.body.accessToken;
      const stolen = refreshCookie(login);
      const refreshed = await client.agent.post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('User-Agent', BROWSER).send({ client: 'web' });
      // Move the rotation outside the short window that tolerates two tabs refreshing together.
      await h.prisma.session.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });

      // Presented from another browser: someone copied it.
      const replay = await request(h.app.getHttpServer())
        .post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('User-Agent', 'curl/8.4.0').set('Cookie', stolen).send({ client: 'web' });
      expect(replay.status).toBe(401);

      // The legitimate user's newer tokens are revoked too.
      client.token = refreshed.body.accessToken;
      expect((await client.get('/auth/me')).status).toBe(401);
      expect((await client.post('/auth/refresh', { client: 'web' })).status).toBe(401);
      expect(await h.prisma.auditLog.count({ where: { action: 'auth.refresh_token_reuse' } })).toBe(1);
    });

    it('lets the same browser try again once when the answer to a renewal was lost, and only once', async () => {
      const send = (cookie: string, agent = BROWSER) =>
        request(h.app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('User-Agent', agent).set('Cookie', cookie).send({ client: 'pos' });
      const login = await request(h.app.getHttpServer()).post('/api/v1/auth/login').set('Origin', ORIGIN).set('User-Agent', BROWSER)
        .send({ email: fx.cashier.email, password: PASSWORD, client: 'pos', terminalId: fx.terminal.id });
      const held = refreshCookie(login, 'pos');
      // The renewal reaches the server, but its answer never reaches the browser: the new token is lost.
      const lost = refreshCookie((await send(held).expect(200)), 'pos');
      await h.prisma.session.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });

      // A minute later the connection is back and the browser tries again with the token it still holds.
      const retried = await send(held).expect(200);
      const fresh = refreshCookie(retried, 'pos');
      await request(h.app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${retried.body.accessToken}`).expect(200);
      expect(await h.prisma.auditLog.count({ where: { action: 'auth.refresh_token_reuse' } })).toBe(0);
      // The old token and the lost one no longer work; the session carries on with the new one.
      expect((await send(held)).status).toBe(401);
      expect((await send(lost)).status).toBe(401);
      expect((await send(fresh)).status).toBe(200);
    });

    it('does not let an old token back in once the token that replaced it was used', async () => {
      const send = (cookie: string) =>
        request(h.app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('User-Agent', BROWSER).set('Cookie', cookie).send({ client: 'pos' });
      const login = await request(h.app.getHttpServer()).post('/api/v1/auth/login').set('Origin', ORIGIN).set('User-Agent', BROWSER)
        .send({ email: fx.cashier.email, password: PASSWORD, client: 'pos', terminalId: fx.terminal.id });
      const first = refreshCookie(login, 'pos');
      const second = refreshCookie((await send(first).expect(200)), 'pos');
      await send(second).expect(200);
      await h.prisma.session.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
      expect((await send(first)).status).toBe(401);
      expect(await h.prisma.auditLog.count({ where: { action: 'auth.refresh_token_reuse' } })).toBe(1);
    });

    it('tolerates two tabs refreshing at the same moment', async () => {
      const login = await h.client().login(fx.owner.email);
      const cookie = refreshCookie(login);
      const send = () =>
        request(h.app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', cookie).send({ client: 'web' });
      const [first, second] = await Promise.all([send(), send()]);
      expect([first.status, second.status]).toEqual([200, 200]);
    });

    it('only accepts cookie-authenticated requests from our own front ends', async () => {
      const login = await h.client().login(fx.owner.email);
      const cookie = refreshCookie(login);
      const base = () => request(h.app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).send({ client: 'web' });
      expect((await base()).status).toBe(403);
      expect((await base().set('Origin', 'https://evil.example')).status).toBe(403);
      expect((await base().set('Origin', ORIGIN)).status).toBe(200);
    });

    it('keeps a separate session per front-end app', async () => {
      const client = h.client();
      await client.login(fx.owner.email, PASSWORD, { client: 'web' });
      await client.login(fx.owner.email, PASSWORD, { client: 'pos' });
      await client.post('/auth/logout', { client: 'web' }).expect(204);

      expect((await client.post('/auth/refresh', { client: 'web' })).status).toBe(401);
      expect((await client.post('/auth/refresh', { client: 'pos' })).status).toBe(200);
    });
  });

  describe('sign out and sessions', () => {
    it('makes the access token unusable immediately on sign out', async () => {
      const client = h.client();
      await client.login(fx.owner.email);
      await client.get('/auth/me').expect(200);
      await client.post('/auth/logout', { client: 'web' }).expect(204);

      expect((await client.get('/auth/me')).status).toBe(401);
      expect((await client.post('/auth/refresh', { client: 'web' })).status).toBe(401);
    });

    it('lists active sessions and signs out another device', async () => {
      const laptop = h.client();
      const phone = h.client();
      await laptop.login(fx.owner.email);
      await phone.login(fx.owner.email);

      const sessions = (await laptop.get('/auth/sessions').expect(200)).body as { id: string; current: boolean }[];
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);

      await laptop.delete(`/auth/sessions/${sessions.find((s) => !s.current)!.id}`).expect(204);
      expect((await phone.get('/auth/me')).status).toBe(401);
      await laptop.get('/auth/me').expect(200);
    });

    it('cannot sign out a session that belongs to someone else', async () => {
      const owner = h.client();
      const cashier = h.client();
      await owner.login(fx.owner.email);
      await cashier.loginPos(fx.cashier.email);
      const ownerSession = ((await owner.get('/auth/sessions')).body as { id: string }[])[0]!;
      expect((await cashier.delete(`/auth/sessions/${ownerSession.id}`)).status).toBe(404);
    });
  });

  describe('passwords', () => {
    it('resets a password through an emailed single-use link and signs out existing sessions', async () => {
      await mailbox.clear();
      const existing = h.client();
      await existing.login(fx.owner.email);

      await h.client().post('/auth/forgot-password', { email: fx.owner.email }).expect(204);
      const mail = await mailbox.latestTo(fx.owner.email);
      expect(mail?.subject).toContain('Reset your');
      const token = /token=([\w-]+)/.exec(mail!.text)![1]!;

      const weak = await h.client().post('/auth/reset-password', { token, password: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe('VALIDATION_FAILED');

      await h.client().post('/auth/reset-password', { token, password: 'a brand new password' }).expect(204);
      expect((await h.client().login(fx.owner.email, PASSWORD)).status).toBe(401);
      expect((await h.client().login(fx.owner.email, 'a brand new password')).status).toBe(200);
      expect((await existing.get('/auth/me')).status).toBe(401);

      const reused = await h.client().post('/auth/reset-password', { token, password: 'another new password' });
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe('RESET_LINK_INVALID');
    });

    it('answers the same way for an unknown email and sends nothing', async () => {
      await mailbox.clear();
      await h.client().post('/auth/forgot-password', { email: 'nobody@test.local' }).expect(204);
      expect(await h.prisma.passwordResetToken.count()).toBe(0);
    });

    it('rejects an expired reset link', async () => {
      await mailbox.clear();
      await h.client().post('/auth/forgot-password', { email: fx.owner.email }).expect(204);
      const token = /token=([\w-]+)/.exec((await mailbox.latestTo(fx.owner.email))!.text)![1]!;
      await h.prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await h.client().post('/auth/reset-password', { token, password: 'a brand new password' })).status).toBe(400);
    });

    it('changes a password only with the current one, and signs out other devices', async () => {
      const here = h.client();
      const elsewhere = h.client();
      await here.login(fx.owner.email);
      await elsewhere.login(fx.owner.email);

      const wrong = await here.post('/auth/change-password', { currentPassword: 'nope', newPassword: 'a brand new password' });
      expect(wrong.body.code).toBe('CURRENT_PASSWORD_WRONG');

      await here.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'a brand new password' }).expect(204);
      await here.get('/auth/me').expect(200);
      expect((await elsewhere.get('/auth/me')).status).toBe(401);
    });
  });

  describe('PIN switch on a shared terminal', () => {
    it('lists PIN users, locks the terminal, and lets another user take over with a PIN', async () => {
      const terminal = h.client();
      await terminal.loginPos(fx.cashier.email, PASSWORD, { client: 'pos', terminalId: fx.terminal.id });

      const users = (await terminal.get('/auth/pin-users?client=pos').expect(200)).body as { name: string }[];
      expect(users.map((u) => u.name).sort()).toEqual(['Cashier', 'Owner']);

      await terminal.post('/auth/lock').expect(204);
      expect((await terminal.get('/auth/me')).status).toBe(401);
      const refresh = await terminal.post('/auth/refresh', { client: 'pos' });
      expect(refresh.status).toBe(401);
      expect(refresh.body.code).toBe('SESSION_LOCKED');

      const wrong = await terminal.post('/auth/pin-login', { client: 'pos', userId: fx.owner.id, pin: CASHIER_PIN });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('INVALID_PIN');

      const switched = await terminal.post('/auth/pin-login', { client: 'pos', userId: fx.owner.id, pin: OWNER_PIN });
      expect(switched.status).toBe(200);
      expect(switched.body.user).toMatchObject({ id: fx.owner.id, terminalId: fx.terminal.id });
      terminal.token = switched.body.accessToken;
      await terminal.get('/auth/me').expect(200);
    });

    it('needs a terminal that is already signed in', async () => {
      const response = await h.client().post('/auth/pin-login', { client: 'pos', userId: fx.owner.id, pin: OWNER_PIN });
      expect(response.status).toBe(401);
    });

    it('cannot switch to a user of another restaurant', async () => {
      const other = await seedRestaurant(h.prisma, 'b');
      const terminal = h.client();
      await terminal.loginPos(fx.cashier.email, PASSWORD, { client: 'pos' });
      const response = await terminal.post('/auth/pin-login', { client: 'pos', userId: other.owner.id, pin: OWNER_PIN });
      expect(response.status).toBe(401);
    });

    it('locks the account after five wrong PINs', async () => {
      const terminal = h.client();
      await terminal.loginPos(fx.cashier.email, PASSWORD, { client: 'pos' });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await terminal.post('/auth/pin-login', { client: 'pos', userId: fx.owner.id, pin: '0000' }).expect(401);
      }
      const locked = await terminal.post('/auth/pin-login', { client: 'pos', userId: fx.owner.id, pin: OWNER_PIN });
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    });
  });

  describe('the mobile app', () => {
    // A native app sends no Origin and holds no cookie: its refresh token travels in a header.
    const mobile = (method: 'get' | 'post', path: string, refreshToken?: string, accessToken?: string) => {
      const req = request(h.app.getHttpServer())[method](`/api/v1${path}`);
      if (refreshToken) req.set('X-Refresh-Token', refreshToken);
      if (accessToken) req.set('Authorization', `Bearer ${accessToken}`);
      return req;
    };
    const signIn = async (email: string, extra: object = {}) =>
      (await mobile('post', '/auth/login').send({ email, password: PASSWORD, client: 'mobile', ...extra }).expect(200)).body as { accessToken: string; refreshToken: string };

    it('is handed its refresh token in the answer, and no cookie', async () => {
      const response = await mobile('post', '/auth/login').send({ email: fx.cashier.email, password: PASSWORD, client: 'mobile' });
      expect(response.status).toBe(200);
      expect(response.body.refreshToken).toEqual(expect.any(String));
      expect(response.headers['set-cookie']).toBeUndefined();
      const session = await h.prisma.session.findFirstOrThrow();
      expect(session.client).toBe('mobile');
      expect(session.refreshTokenHash).not.toContain(response.body.refreshToken);
    });

    it('renews its session with the header alone, and a used token ends the session', async () => {
      const first = await signIn(fx.cashier.email);
      const renewed = await mobile('post', '/auth/refresh', first.refreshToken).send({ client: 'mobile' });
      expect(renewed.status).toBe(200);
      expect(renewed.body.refreshToken).not.toBe(first.refreshToken);
      await mobile('get', '/auth/me', undefined, renewed.body.accessToken).expect(200);

      await h.prisma.session.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
      expect((await mobile('post', '/auth/refresh', first.refreshToken).send({ client: 'mobile' })).status).toBe(401);
      expect((await mobile('post', '/auth/refresh', renewed.body.refreshToken).send({ client: 'mobile' })).status).toBe(401);
    });

    it('is refused without its token, and a browser cookie is never accepted in its place', async () => {
      expect((await mobile('post', '/auth/refresh').send({ client: 'mobile' })).status).toBe(401);

      // A forged cross-site request that names the mobile client gets nothing from the victim's cookie.
      const browser = await h.client().loginPos(fx.cashier.email);
      const cookie = refreshCookie(browser, 'pos');
      const forged = (name: string) => request(h.app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', 'https://evil.example').set('Cookie', cookie).send({ client: name });
      expect((await forged('mobile')).status).toBe(401);
      expect((await forged('pos')).status).toBe(403);
      // And a browser session's token is not a mobile session's token.
      expect((await mobile('post', '/auth/refresh', cookie.split('=')[1]).send({ client: 'mobile' })).status).toBe(401);
    });

    it('chooses a terminal, locks, and is unlocked with a PIN', async () => {
      const first = await signIn(fx.cashier.email);
      const chosen = await mobile('post', '/auth/terminal', first.refreshToken, first.accessToken).send({ client: 'mobile', terminalId: fx.terminal.id });
      expect(chosen.status).toBe(200);
      expect(chosen.body.user.terminalId).toBe(fx.terminal.id);

      const users = await mobile('get', '/auth/pin-users?client=mobile', chosen.body.refreshToken);
      expect(users.status).toBe(200);
      expect((users.body as { name: string }[]).map((user) => user.name).sort()).toEqual(['Cashier', 'Owner']);

      await mobile('post', '/auth/lock', undefined, chosen.body.accessToken).expect(204);
      const locked = await mobile('post', '/auth/refresh', chosen.body.refreshToken).send({ client: 'mobile' });
      expect(locked.body.code).toBe('SESSION_LOCKED');

      const unlocked = await mobile('post', '/auth/pin-login', chosen.body.refreshToken).send({ client: 'mobile', userId: fx.owner.id, pin: OWNER_PIN });
      expect(unlocked.status).toBe(200);
      expect(unlocked.body.user).toMatchObject({ id: fx.owner.id, terminalId: fx.terminal.id });
      expect(unlocked.body.refreshToken).toEqual(expect.any(String));
    });

    it('signs out', async () => {
      const first = await signIn(fx.cashier.email);
      await mobile('post', '/auth/logout', first.refreshToken).send({ client: 'mobile' }).expect(204);
      expect((await mobile('post', '/auth/refresh', first.refreshToken).send({ client: 'mobile' })).status).toBe(401);
      expect((await mobile('get', '/auth/me', undefined, first.accessToken)).status).toBe(401);
    });
  });

  it('never stores passwords, PINs or refresh tokens in readable form', async () => {
    const login = await h.client().login(fx.owner.email);
    const raw = refreshCookie(login).split('=')[1]!;
    const user = await h.prisma.user.findUniqueOrThrow({ where: { id: fx.owner.id } });
    const session = await h.prisma.session.findFirstOrThrow();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.pinHash).toMatch(/^\$argon2id\$/);
    expect(session.refreshTokenHash).not.toBe(raw);
    expect(session.refreshTokenHash).toHaveLength(64);
  });
});
