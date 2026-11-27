import { createHarness, type Fixture, type Harness, seedRestaurant, type TestClient } from './support/harness.js';

describe('restaurant settings', () => {
  let h: Harness;
  let fx: Fixture;
  let owner: TestClient;
  let cashier: TestClient;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    fx = await seedRestaurant(h.prisma);
    owner = h.client();
    cashier = h.client();
    await owner.login(fx.owner.email);
    await cashier.loginPos(fx.cashier.email);
  });
  afterAll(async () => {
    await h.close();
  });

  describe('profile', () => {
    it('updates the profile and derives the state name', async () => {
      const response = await owner.patch('/restaurant', {
        name: 'Spice Route', gstin: '29abcde1234f1z5', stateCode: '29', fssaiNumber: '12345678901234', pincode: '560001', phone: '',
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ name: 'Spice Route', gstin: '29ABCDE1234F1Z5', stateCode: '29', stateName: 'Karnataka', phone: null });
      expect(await h.prisma.auditLog.count({ where: { action: 'restaurant.updated' } })).toBe(1);
    });

    it('rejects a GSTIN that does not match the state, in one request or across two', async () => {
      const together = await owner.patch('/restaurant', { gstin: '29ABCDE1234F1Z5', stateCode: '27' });
      expect(together.status).toBe(400);
      const stateOnly = await owner.patch('/restaurant', { stateCode: '29' });
      expect(stateOnly.status).toBe(422);
      expect(stateOnly.body.code).toBe('GSTIN_STATE_MISMATCH');
    });

    it('rejects malformed GSTIN, FSSAI and PIN code', async () => {
      const response = await owner.patch('/restaurant', { gstin: '27ABC', fssaiNumber: '123', pincode: '4000' });
      expect(response.status).toBe(400);
      expect(response.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['fssaiNumber', 'gstin', 'pincode']);
    });

    it('lets every signed-in user read the profile but only settings managers change it', async () => {
      await cashier.get('/restaurant').expect(200);
      expect((await cashier.patch('/restaurant', { name: 'Nope' })).status).toBe(403);
    });
  });

  describe('billing settings', () => {
    it('updates billing settings', async () => {
      const response = await owner.patch('/settings', {
        pricesIncludeTax: true, dayCutoffMinutes: 300, orderRenumberMode: 'MANUAL', orderNumberReset: 'FINANCIAL_YEAR',
        serviceChargeEnabled: true, serviceChargeBps: 500, invoiceFooter: 'Thank you', upiVpa: 'shop@upi', autoPrintReceipt: false,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        pricesIncludeTax: true, dayCutoffMinutes: 300, orderRenumberMode: 'MANUAL', orderNumberReset: 'FINANCIAL_YEAR',
        serviceChargeBps: 500, upiVpa: 'shop@upi', gstRegistration: 'REGULAR', autoPrintReceipt: false,
      });
      expect((await cashier.get('/settings').expect(200)).body.dayCutoffMinutes).toBe(300);
    });

    it('rejects out-of-range values', async () => {
      const response = await owner.patch('/settings', { dayCutoffMinutes: 1500, serviceChargeBps: 5000, upiVpa: 'not a vpa' });
      expect(response.status).toBe(400);
      expect(response.body.details).toHaveLength(3);
    });

    it('requires a GSTIN for a GST-registered restaurant', async () => {
      // Clearing the GSTIN while registered is refused.
      expect((await owner.patch('/restaurant', { gstin: null })).body.code).toBe('GSTIN_REQUIRED');
      // Unregistered first, then the GSTIN can go; registering again without one is refused.
      await owner.patch('/settings', { gstRegistration: 'UNREGISTERED' }).expect(200);
      await owner.patch('/restaurant', { gstin: null }).expect(200);
      expect((await owner.patch('/settings', { gstRegistration: 'REGULAR' })).body.code).toBe('GSTIN_REQUIRED');
    });
  });

  describe('tax groups', () => {
    it('creates a tax group with CGST and SGST as exact halves and IGST as the full rate', async () => {
      const response = await owner.post('/tax-groups', { name: 'GST 18%', gstRateBps: 1800 });
      expect(response.status).toBe(201);
      expect(response.body.components).toEqual([
        { type: 'CGST', name: 'CGST', rateBps: 900 },
        { type: 'SGST', name: 'SGST', rateBps: 900 },
        { type: 'IGST', name: 'IGST', rateBps: 1800 },
      ]);
    });

    it('adds a cess component only when a cess rate is given', async () => {
      const response = await owner.post('/tax-groups', { name: 'GST 28% + Cess', gstRateBps: 2800, cessRateBps: 1200 });
      expect(response.body.components).toContainEqual({ type: 'CESS', name: 'Cess', rateBps: 1200 });
      expect(response.body).toMatchObject({ gstRateBps: 2800, cessRateBps: 1200 });
    });

    it('rejects a rate that cannot split evenly, and a duplicate name', async () => {
      expect((await owner.post('/tax-groups', { name: 'Odd', gstRateBps: 25 })).status).toBe(400);
      const duplicate = await owner.post('/tax-groups', { name: 'gst 5%', gstRateBps: 500 });
      expect(duplicate.status).toBe(409);
    });

    it('changes the rate by replacing the components', async () => {
      const response = await owner.patch(`/tax-groups/${fx.taxGroup.id}`, { gstRateBps: 1200 });
      expect(response.body.gstRateBps).toBe(1200);
      expect(response.body.components.map((c: { rateBps: number }) => c.rateBps)).toEqual([600, 600, 1200]);
      expect(await h.prisma.taxComponent.count({ where: { taxGroupId: fx.taxGroup.id } })).toBe(3);
    });

    it('will not delete or deactivate the default group, or delete one that products use', async () => {
      expect((await owner.delete(`/tax-groups/${fx.taxGroup.id}`)).body.code).toBe('TAX_GROUP_IS_DEFAULT');
      expect((await owner.patch(`/tax-groups/${fx.taxGroup.id}`, { isActive: false })).body.code).toBe('TAX_GROUP_IS_DEFAULT');

      const other = (await owner.post('/tax-groups', { name: 'GST 18%', gstRateBps: 1800 })).body;
      await owner.post('/products', { categoryId: fx.category.id, name: 'Cola', basePricePaise: 5000, taxGroupId: other.id }).expect(201);
      expect((await owner.delete(`/tax-groups/${other.id}`)).body.code).toBe('TAX_GROUP_IN_USE');

      const unused = (await owner.post('/tax-groups', { name: 'GST 12%', gstRateBps: 1200 })).body;
      await owner.delete(`/tax-groups/${unused.id}`).expect(204);
    });
  });

  describe('terminals and kitchen stations', () => {
    it('registers a terminal with an upper-case code and refuses a duplicate code', async () => {
      const created = await owner.post('/terminals', { name: 'Counter 2', code: 'b2' });
      expect(created.body).toMatchObject({ code: 'B2', isActive: true });
      expect((await owner.post('/terminals', { name: 'Again', code: 'B2' })).body.code).toBe('TERMINAL_CODE_TAKEN');
      expect((await owner.post('/terminals', { name: 'Bad', code: 'TOO-LONG' })).status).toBe(400);
    });

    it('renames and deactivates a terminal but never changes its code', async () => {
      const response = await owner.patch(`/terminals/${fx.terminal.id}`, { name: 'Front Desk', isActive: false, code: 'ZZ' });
      expect(response.body).toMatchObject({ name: 'Front Desk', isActive: false, code: 'A1' });
    });

    it('creates stations in order and refuses to delete one that products use', async () => {
      const bar = (await owner.post('/stations', { name: 'Bar' })).body;
      expect(bar.sortOrder).toBe(1);
      expect((await owner.post('/stations', { name: 'bar' })).status).toBe(409);

      await owner.post('/products', { categoryId: fx.category.id, name: 'Mojito', basePricePaise: 18000, stationId: bar.id }).expect(201);
      expect((await owner.delete(`/stations/${bar.id}`)).body.code).toBe('STATION_IN_USE');
      await owner.delete(`/stations/${fx.station.id}`).expect(204);
    });
  });

  it('keeps one restaurant\'s settings invisible and untouchable from another', async () => {
    const other = await seedRestaurant(h.prisma, 'b');
    const taxGroups = (await owner.get('/tax-groups')).body as { id: string }[];
    expect(taxGroups.map((g) => g.id)).toEqual([fx.taxGroup.id]);
    expect((await owner.patch(`/tax-groups/${other.taxGroup.id}`, { name: 'x' })).status).toBe(404);
    expect((await owner.patch(`/terminals/${other.terminal.id}`, { name: 'x' })).status).toBe(404);
    expect((await owner.delete(`/stations/${other.station.id}`)).status).toBe(404);
    expect((await owner.patch('/settings', { defaultTaxGroupId: other.taxGroup.id })).status).toBe(422);
  });
});
