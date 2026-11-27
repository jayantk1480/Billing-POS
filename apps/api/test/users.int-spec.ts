import { createHarness, type Fixture, type Harness, PASSWORD, seedRestaurant, type TestClient } from './support/harness.js';

describe('users and roles', () => {
  let h: Harness;
  let fx: Fixture;
  let owner: TestClient;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    fx = await seedRestaurant(h.prisma);
    owner = h.client();
    await owner.login(fx.owner.email);
  });
  afterAll(async () => {
    await h.close();
  });

  const newUser = (overrides: object = {}) => ({
    name: 'Asha', email: 'asha@test.local', roleId: fx.roles.cashier, password: 'a long enough password', pin: '1357', ...overrides,
  });

  it('refuses user management to a role without the permission', async () => {
    const cashier = h.client();
    await cashier.loginPos(fx.cashier.email);
    const response = await cashier.get('/users');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect((await cashier.post('/users', newUser())).status).toBe(403);
  });

  it('creates a user who can then sign in, and never returns secrets', async () => {
    const created = await owner.post('/users', newUser({ email: 'Asha@Test.Local' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: 'asha@test.local', hasPin: true, isActive: true, role: { key: 'cashier' } });
    expect(JSON.stringify(created.body)).not.toMatch(/hash|password/i);

    expect((await h.client().loginPos('asha@test.local', 'a long enough password')).status).toBe(200);
    const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.created' } });
    expect(JSON.stringify(audit.after)).not.toMatch(/hash|a long enough password/i);
  });

  it('rejects a duplicate email and reports each invalid field', async () => {
    const duplicate = await owner.post('/users', newUser({ email: fx.cashier.email }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_TAKEN');

    const invalid = await owner.post('/users', newUser({ email: 'not-an-email', password: 'short', pin: '12' }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'password', 'pin']);
  });

  it('signs a user out when they are deactivated, and blocks sign-in', async () => {
    const cashier = h.client();
    await cashier.loginPos(fx.cashier.email);
    await owner.patch(`/users/${fx.cashier.id}`, { isActive: false }).expect(200);

    expect((await cashier.get('/auth/me')).status).toBe(401);
    expect((await h.client().loginPos(fx.cashier.email)).status).toBe(401);
  });

  it('signs a user out when their role changes, so new permissions apply at next sign-in', async () => {
    const cashier = h.client();
    await cashier.loginPos(fx.cashier.email);
    await owner.patch(`/users/${fx.cashier.id}`, { roleId: fx.roles.manager }).expect(200);
    expect((await cashier.get('/auth/me')).status).toBe(401);

    await cashier.loginPos(fx.cashier.email);
    expect((await cashier.get('/auth/me')).body.role.key).toBe('manager');
  });

  it('lets an admin set a new password and remove a PIN', async () => {
    const updated = await owner.patch(`/users/${fx.cashier.id}`, { password: 'replacement password', pin: null });
    expect(updated.body.hasPin).toBe(false);
    expect((await h.client().loginPos(fx.cashier.email, PASSWORD)).status).toBe(401);
    expect((await h.client().loginPos(fx.cashier.email, 'replacement password')).status).toBe(200);
  });

  it('stops you changing your own role or deactivating yourself', async () => {
    for (const body of [{ isActive: false }, { roleId: fx.roles.cashier }]) {
      const response = await owner.patch(`/users/${fx.owner.id}`, body);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('CANNOT_CHANGE_SELF');
    }
  });

  it('keeps at least one active owner', async () => {
    const second = (await owner.post('/users', newUser({ email: 'owner2@test.local', roleId: fx.roles.owner }))).body;
    const secondClient = h.client();
    await secondClient.login('owner2@test.local', 'a long enough password');

    await secondClient.patch(`/users/${fx.owner.id}`, { isActive: false }).expect(200);
    // The first owner is now inactive, so the second is the last one and cannot be demoted by anyone.
    await h.prisma.user.update({ where: { id: fx.cashier.id }, data: { roleId: fx.roles.owner } });
    const third = h.client();
    await third.loginPos(fx.cashier.email);
    await third.patch(`/users/${second.id}`, { isActive: false }).expect(200);
    const last = await h.client().loginPos(fx.cashier.email).then(() => third.patch(`/users/${fx.cashier.id}`, { isActive: false }));
    expect(last.status).toBe(422);
  });

  it('cannot see or edit users of another restaurant', async () => {
    const other = await seedRestaurant(h.prisma, 'b');
    const list = (await owner.get('/users').expect(200)).body as { id: string }[];
    expect(list.map((u) => u.id).sort()).toEqual([fx.owner.id, fx.cashier.id].sort());
    expect((await owner.patch(`/users/${other.cashier.id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await owner.post('/users', newUser({ roleId: other.roles.cashier }))).status).toBe(404);
  });

  describe('roles', () => {
    it('lists permissions and the built-in roles', async () => {
      const permissions = (await owner.get('/permissions').expect(200)).body as { key: string }[];
      expect(permissions.map((p) => p.key)).toContain('refund.create');
      const roles = (await owner.get('/roles').expect(200)).body as { key: string; userCount: number }[];
      expect(roles.map((r) => r.key)).toEqual(['owner', 'manager', 'cashier', 'captain', 'kitchen']);
      expect(roles.find((r) => r.key === 'owner')!.userCount).toBe(1);
    });

    it('creates, edits and deletes a custom role', async () => {
      const created = await owner.post('/roles', { name: 'Shift Lead', permissions: ['menu.view', 'order.create'] });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ key: 'shift-lead', isSystem: false, permissions: ['menu.view', 'order.create'] });

      const updated = await owner.patch(`/roles/${created.body.id}`, { permissions: ['menu.view'] });
      expect(updated.body.permissions).toEqual(['menu.view']);

      await owner.patch(`/users/${fx.cashier.id}`, { roleId: created.body.id }).expect(200);
      const inUse = await owner.delete(`/roles/${created.body.id}`);
      expect(inUse.status).toBe(409);
      await owner.patch(`/users/${fx.cashier.id}`, { roleId: fx.roles.cashier }).expect(200);
      await owner.delete(`/roles/${created.body.id}`).expect(204);
    });

    it('applies a permission change to signed-in users straight away', async () => {
      const cashier = h.client();
      await cashier.loginPos(fx.cashier.email);
      expect((await cashier.post('/categories', { name: 'Soups' })).status).toBe(403);

      const cashierRole = ((await owner.get('/roles')).body as { id: string; key: string; permissions: string[] }[]).find((r) => r.key === 'cashier')!;
      await owner.patch(`/roles/${cashierRole.id}`, { permissions: [...cashierRole.permissions, 'menu.manage'] }).expect(200);
      expect((await cashier.post('/categories', { name: 'Soups' })).status).toBe(201);
    });

    it('protects the Owner role and built-in roles', async () => {
      expect((await owner.patch(`/roles/${fx.roles.owner}`, { permissions: [] })).body.code).toBe('OWNER_ROLE_FIXED');
      expect((await owner.delete(`/roles/${fx.roles.kitchen}`)).body.code).toBe('SYSTEM_ROLE');
    });

    it('prevents granting permissions you do not hold', async () => {
      // A custom role that can manage users but nothing else.
      const hr = (await owner.post('/roles', { name: 'HR', permissions: ['users.manage'] })).body;
      await owner.patch(`/users/${fx.cashier.id}`, { roleId: hr.id }).expect(200);
      const limited = h.client();
      await limited.loginPos(fx.cashier.email);

      expect((await limited.post('/roles', { name: 'Sneaky', permissions: ['refund.create'] })).status).toBe(403);
      expect((await limited.post('/users', newUser({ roleId: fx.roles.owner }))).status).toBe(403);
      expect((await limited.patch(`/users/${fx.owner.id}`, { password: 'take over the owner' })).status).toBe(403);
      expect((await limited.patch(`/roles/${hr.id}`, { permissions: ['users.manage', 'settings.manage'] })).status).toBe(403);
      // Within their own permissions they can still work.
      expect((await limited.post('/users', newUser({ roleId: hr.id }))).status).toBe(201);
    });
  });
});
