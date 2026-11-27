import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createHarness, type Fixture, type Harness, seedRestaurant, type TestClient } from './support/harness.js';

// The smallest valid PNG: a 1×1 transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64',
);

describe('menu management', () => {
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
    await rm(path.resolve(import.meta.dirname, '../../../storage/test'), { recursive: true, force: true });
  });

  const product = (overrides: object = {}) => ({ categoryId: fx.category.id, name: 'Paneer Tikka', basePricePaise: 26000, ...overrides });

  describe('categories', () => {
    it('creates categories at the end of the list and reorders them', async () => {
      const mains = (await owner.post('/categories', { name: 'Mains', color: '#dc2626' }).expect(201)).body;
      const drinks = (await owner.post('/categories', { name: 'Drinks' }).expect(201)).body;
      expect([mains.sortOrder, drinks.sortOrder]).toEqual([1, 2]);

      const reordered = await owner.put('/categories/order', { ids: [drinks.id, fx.category.id, mains.id] });
      expect(reordered.body.map((c: { name: string }) => c.name)).toEqual(['Drinks', 'Starters', 'Mains']);
      expect((await cashier.get('/categories')).body.map((c: { name: string }) => c.name)).toEqual(['Drinks', 'Starters', 'Mains']);
    });

    it('rejects a reorder that does not list every category exactly once', async () => {
      const mains = (await owner.post('/categories', { name: 'Mains' })).body;
      expect((await owner.put('/categories/order', { ids: [mains.id] })).body.code).toBe('REORDER_MISMATCH');
      expect((await owner.put('/categories/order', { ids: [mains.id, mains.id] })).body.code).toBe('REORDER_MISMATCH');
    });

    it('refuses a duplicate name, and deleting a category that still has products', async () => {
      expect((await owner.post('/categories', { name: 'starters' })).status).toBe(409);
      await owner.post('/products', product()).expect(201);
      const blocked = await owner.delete(`/categories/${fx.category.id}`);
      expect(blocked.body.code).toBe('CATEGORY_NOT_EMPTY');

      const empty = (await owner.post('/categories', { name: 'Empty' })).body;
      await owner.delete(`/categories/${empty.id}`).expect(204);
      // The name is free again after deletion.
      await owner.post('/categories', { name: 'Empty' }).expect(201);
    });
  });

  describe('modifier groups', () => {
    const group = (overrides: object = {}) => ({
      name: 'Add-ons', minSelect: 0, maxSelect: 2,
      modifiers: [{ name: 'Extra Cheese', pricePaise: 4000 }, { name: 'Extra Raita', pricePaise: 3000 }],
      ...overrides,
    });

    it('creates a group and replaces its options, keeping the ids of options that stay', async () => {
      const created = (await owner.post('/modifier-groups', group()).expect(201)).body;
      const [cheese, raita] = created.modifiers;

      const updated = await owner.put(`/modifier-groups/${created.id}`, group({
        modifiers: [{ id: raita.id, name: 'Raita', pricePaise: 3500 }, { name: 'Papad', pricePaise: 2000 }],
      }));
      expect(updated.body.modifiers.map((m: { name: string }) => m.name)).toEqual(['Raita', 'Papad']);
      expect(updated.body.modifiers[0].id).toBe(raita.id);
      // The removed option is kept in the database for old orders, but hidden.
      expect((await h.prisma.modifier.findUniqueOrThrow({ where: { id: cheese.id } })).deletedAt).not.toBeNull();
    });

    it('validates selection limits and option names', async () => {
      expect((await owner.post('/modifier-groups', group({ minSelect: 3, maxSelect: 2 }))).status).toBe(400);
      expect((await owner.post('/modifier-groups', group({ minSelect: 2, maxSelect: 5, modifiers: [{ name: 'Only', pricePaise: 0 }] }))).status).toBe(400);
      expect((await owner.post('/modifier-groups', group({ modifiers: [] }))).status).toBe(400);
      const duplicate = await owner.post('/modifier-groups', group({ modifiers: [{ name: 'A', pricePaise: 0 }, { name: 'a', pricePaise: 0 }] }));
      expect(duplicate.body.code).toBe('DUPLICATE_NAME');
    });

    it('detaches a deleted group from its products', async () => {
      const created = (await owner.post('/modifier-groups', group())).body;
      const item = (await owner.post('/products', product({ modifierGroupIds: [created.id] })).expect(201)).body;
      expect((await owner.get('/modifier-groups')).body[0].productCount).toBe(1);

      await owner.delete(`/modifier-groups/${created.id}`).expect(204);
      expect((await owner.get(`/products/${item.id}`)).body.modifierGroupIds).toEqual([]);
      expect((await owner.get('/modifier-groups')).body).toEqual([]);
    });
  });

  describe('products', () => {
    it('creates a product with defaults and returns it in the list', async () => {
      const created = await owner.post('/products', product({ shortCode: 'pt', hsnSac: '996331', stationId: fx.station.id }));
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Paneer Tikka', shortCode: 'PT', basePricePaise: 26000, foodType: 'VEG', isAvailable: true,
        categoryName: 'Starters', taxGroupId: null, priceIncludesTax: null, variants: [], imageUrl: null,
      });
      const list = (await cashier.get('/products').expect(200)).body;
      expect(list).toMatchObject({ total: 1, page: 1 });
      expect(list.items[0].id).toBe(created.body.id);
    });

    it('uses the first variant as the default and its price as the headline price', async () => {
      const created = await owner.post('/products', product({
        name: 'Tandoori Chicken', foodType: 'NON_VEG', basePricePaise: 1,
        variants: [{ name: 'Half', pricePaise: 28000 }, { name: 'Full', pricePaise: 52000 }],
      }));
      expect(created.body.basePricePaise).toBe(28000);
      expect(created.body.variants.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault])).toEqual([['Half', true], ['Full', false]]);
    });

    it('replaces variants on update: keeps, adds and removes', async () => {
      const created = (await owner.post('/products', product({
        variants: [{ name: 'Half', pricePaise: 28000 }, { name: 'Full', pricePaise: 52000 }],
      }))).body;
      const [half, full] = created.variants;

      const updated = await owner.patch(`/products/${created.id}`, {
        variants: [{ id: full.id, name: 'Full', pricePaise: 55000 }, { name: 'Family', pricePaise: 90000 }],
      });
      expect(updated.body.variants.map((v: { name: string }) => v.name)).toEqual(['Full', 'Family']);
      expect(updated.body.variants[0]).toMatchObject({ id: full.id, isDefault: true, pricePaise: 55000 });
      expect(updated.body.basePricePaise).toBe(55000);
      expect((await h.prisma.variant.findUniqueOrThrow({ where: { id: half.id } })).deletedAt).not.toBeNull();
    });

    it('changes only the fields that are sent', async () => {
      const created = (await owner.post('/products', product({ shortCode: 'PT', description: 'Smoky', isFavourite: true }))).body;
      const updated = await owner.patch(`/products/${created.id}`, { basePricePaise: 27500 });
      expect(updated.body).toMatchObject({ basePricePaise: 27500, shortCode: 'PT', description: 'Smoky', isFavourite: true });

      const cleared = await owner.patch(`/products/${created.id}`, { shortCode: '', description: null });
      expect(cleared.body).toMatchObject({ shortCode: null, description: null });
    });

    it('keeps short codes unique, and frees a code when its product is deleted', async () => {
      const first = (await owner.post('/products', product({ shortCode: 'PT' }))).body;
      const clash = await owner.post('/products', product({ name: 'Peri Tikka', shortCode: 'pt' }));
      expect(clash.status).toBe(409);
      expect(clash.body.message).toContain('Paneer Tikka');

      await owner.delete(`/products/${first.id}`).expect(204);
      expect((await owner.get(`/products/${first.id}`)).status).toBe(404);
      await owner.post('/products', product({ name: 'Peri Tikka', shortCode: 'PT' })).expect(201);
    });

    it('searches by name or short code and filters by category and availability', async () => {
      const mains = (await owner.post('/categories', { name: 'Mains' })).body;
      await owner.post('/products', product({ shortCode: 'PT' }));
      await owner.post('/products', product({ name: 'Paneer Butter Masala', shortCode: 'PBM', categoryId: mains.id }));
      const dal = (await owner.post('/products', product({ name: 'Dal Makhani', categoryId: mains.id }))).body;
      await owner.patch(`/products/${dal.id}/availability`, { isAvailable: false });

      const names = async (query: string) => ((await owner.get(`/products?${query}`)).body.items as { name: string }[]).map((p) => p.name);
      expect(await names('search=paneer')).toEqual(['Paneer Tikka', 'Paneer Butter Masala']);
      expect(await names('search=pbm')).toEqual(['Paneer Butter Masala']);
      expect(await names(`categoryId=${mains.id}`)).toEqual(['Paneer Butter Masala', 'Dal Makhani']);
      expect(await names('availability=unavailable')).toEqual(['Dal Makhani']);
      const paged = (await owner.get('/products?pageSize=2&page=2')).body;
      expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(paged.items).toHaveLength(1);
    });

    it('lets a cashier switch availability but not edit or delete', async () => {
      const created = (await owner.post('/products', product())).body;
      const toggled = await cashier.patch(`/products/${created.id}/availability`, { isAvailable: false });
      expect(toggled.status).toBe(200);
      expect(toggled.body.isAvailable).toBe(false);

      expect((await cashier.patch(`/products/${created.id}`, { basePricePaise: 1 })).status).toBe(403);
      expect((await cashier.delete(`/products/${created.id}`)).status).toBe(403);
      expect((await cashier.post('/products', product({ name: 'X' }))).status).toBe(403);
    });

    it('validates fields and references', async () => {
      const invalid = await owner.post('/products', product({ name: '', basePricePaise: -5, shortCode: 'TOO-LONG!!', hsnSac: '12' }));
      expect(invalid.status).toBe(400);
      expect(invalid.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['basePricePaise', 'hsnSac', 'name', 'shortCode']);

      expect((await owner.post('/products', product({ basePricePaise: 260.5 }))).status).toBe(400);
      const duplicateVariant = await owner.post('/products', product({ variants: [{ name: 'Half', pricePaise: 1 }, { name: 'half', pricePaise: 2 }] }));
      expect(duplicateVariant.body.code).toBe('DUPLICATE_NAME');
    });

    it('cannot read, change or reference another restaurant\'s menu', async () => {
      const other = await seedRestaurant(h.prisma, 'b');
      const otherOwner = h.client();
      await otherOwner.login(other.owner.email);
      const theirs = (await otherOwner.post('/products', { categoryId: other.category.id, name: 'Secret Dish', basePricePaise: 100 })).body;

      expect((await owner.get('/products')).body.total).toBe(0);
      expect((await owner.get(`/products/${theirs.id}`)).status).toBe(404);
      expect((await owner.patch(`/products/${theirs.id}`, { name: 'Mine' })).status).toBe(404);
      expect((await owner.delete(`/products/${theirs.id}`)).status).toBe(404);
      expect((await owner.post('/products', product({ categoryId: other.category.id }))).body.code).toBe('CATEGORY_NOT_FOUND');
      expect((await owner.post('/products', product({ taxGroupId: other.taxGroup.id }))).body.code).toBe('TAX_GROUP_NOT_FOUND');
      expect((await owner.post('/products', product({ stationId: other.station.id }))).body.code).toBe('STATION_NOT_FOUND');
    });

    it('records who changed a price', async () => {
      const created = (await owner.post('/products', product())).body;
      await owner.patch(`/products/${created.id}`, { basePricePaise: 30000 });
      const entry = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'product.updated' } });
      expect(entry.userId).toBe(fx.owner.id);
      expect((entry.before as { basePricePaise: number }).basePricePaise).toBe(26000);
      expect((entry.after as { basePricePaise: number }).basePricePaise).toBe(30000);
    });
  });

  describe('adding and deleting many products at once', () => {
    const row = (overrides: object = {}) => ({ name: 'Paneer Tikka', category: 'Starters', price: '260', ...overrides });
    const names = async () => (await owner.get('/products?pageSize=200')).body.items.map((p: { name: string }) => p.name).sort();

    it('adds every good row, creates the categories that are missing, and reads prices as rupees', async () => {
      const result = await owner.post('/products/bulk', {
        rows: [
          row({ shortCode: 'pt', foodType: 'Veg', taxGroup: fx.taxGroup.name.toUpperCase(), hsnSac: '996331', description: 'Char-grilled' }),
          row({ name: 'Chicken Tikka', price: '₹1,250.50', foodType: 'Non-Veg' }),
          row({ name: 'Tomato Soup', category: 'Soups', price: '120.5' }),
          row({ name: 'Sweet Corn Soup', category: 'soups', price: 'Rs. 130', foodType: 'egg' }),
        ],
      }).expect(200);
      expect(result.body).toMatchObject({ saved: true, created: 4, duplicates: 0, errors: 0, newCategories: ['Soups'] });
      expect(result.body.rows.map((r: { status: string }) => r.status)).toEqual(['created', 'created', 'created', 'created']);

      const items = (await owner.get('/products?pageSize=200')).body.items as { name: string; categoryName: string; basePricePaise: number; shortCode: string | null; foodType: string; taxGroupId: string | null; hsnSac: string | null; description: string | null; sortOrder: number }[];
      const by = (name: string) => items.find((p) => p.name === name)!;
      expect(by('Paneer Tikka')).toMatchObject({ categoryName: 'Starters', basePricePaise: 26000, shortCode: 'PT', foodType: 'VEG', taxGroupId: fx.taxGroup.id, hsnSac: '996331', description: 'Char-grilled', sortOrder: 0 });
      expect(by('Chicken Tikka')).toMatchObject({ basePricePaise: 125050, foodType: 'NON_VEG', taxGroupId: null, shortCode: null, sortOrder: 1 });
      expect(by('Tomato Soup')).toMatchObject({ categoryName: 'Soups', basePricePaise: 12050, sortOrder: 0 });
      expect(by('Sweet Corn Soup')).toMatchObject({ categoryName: 'Soups', foodType: 'EGG', sortOrder: 1 });
      // One new category, written as it was first spelled, after the existing one.
      expect((await owner.get('/categories')).body.map((c: { name: string; productCount: number }) => [c.name, c.productCount])).toEqual([['Starters', 2], ['Soups', 2]]);

      const entry = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'product.bulk_created' } });
      expect(entry.userId).toBe(fx.owner.id);
      expect(entry.after).toMatchObject({ count: 4, newCategories: ['Soups'] });
    });

    it('saves nothing on a dry run, and says what would happen', async () => {
      const result = await owner.post('/products/bulk', { dryRun: true, rows: [row(), row({ name: 'Tomato Soup', category: 'Soups' })] }).expect(200);
      expect(result.body).toMatchObject({ saved: false, created: 2, newCategories: ['Soups'] });
      expect(result.body.rows.map((r: { status: string }) => r.status)).toEqual(['ready', 'ready']);
      expect(await names()).toEqual([]);
      expect((await owner.get('/categories')).body).toHaveLength(1);
    });

    it('skips rows with mistakes and products already on the menu, and adds the rest', async () => {
      await owner.post('/products', product({ shortCode: 'PT' })).expect(201);
      const result = await owner.post('/products/bulk', {
        rows: [
          row({ name: 'paneer tikka' }), // already on the menu, whatever the capitals
          row({ name: 'Veg Roll' }),
          row({ name: 'Veg Roll' }), // twice in the file
          row({ name: '', price: 'abc', foodType: 'fish' }),
          row({ name: 'Peri Tikka', shortCode: 'PT' }), // code of an existing product
          row({ name: 'Corn Tikki', shortCode: 'CT' }),
          row({ name: 'Cheese Toast', shortCode: 'ct' }), // code of an earlier row
          row({ name: 'Mystery', taxGroup: 'No such tax' }),
          row({ name: 'No Category', category: '' }),
          row({ name: 'Bad Code', shortCode: 'TOO-LONG!' }),
        ],
      }).expect(200);
      expect(result.body).toMatchObject({ saved: true, created: 2, duplicates: 2, errors: 6, newCategories: [] });
      const rows = result.body.rows as { status: string; message: string | null }[];
      expect(rows.map((r) => r.status)).toEqual(['duplicate', 'created', 'duplicate', 'error', 'error', 'created', 'error', 'error', 'error', 'error']);
      expect(rows[0]!.message).toBe('"paneer tikka" is already in Starters.');
      expect(rows[3]!.message).toBe('Name is missing. "abc" is not a price. Type "fish" is not veg, non-veg or egg.');
      expect(rows[4]!.message).toBe('Short code PT is already used by "Paneer Tikka".');
      expect(rows[6]!.message).toBe('Short code CT is already used by "Corn Tikki".');
      expect(rows[7]!.message).toBe('There is no tax group named "No such tax".');
      expect(rows[8]!.message).toBe('Category is missing.');
      expect(await names()).toEqual(['Corn Tikki', 'Paneer Tikka', 'Veg Roll']);
    });

    it('refuses an empty list, too many rows, and users who cannot manage the menu', async () => {
      expect((await owner.post('/products/bulk', { rows: [] })).status).toBe(400);
      expect((await owner.post('/products/bulk', { rows: Array.from({ length: 501 }, (_, i) => row({ name: `Item ${i}` })) })).status).toBe(400);
      expect((await cashier.post('/products/bulk', { rows: [row()] })).status).toBe(403);
      expect((await cashier.post('/products/bulk-delete', { ids: [fx.category.id] })).status).toBe(403);
      expect((await owner.post('/products/bulk-delete', { ids: [] })).status).toBe(400);
    });

    it('uses only this restaurant\'s categories and tax groups', async () => {
      const other = await seedRestaurant(h.prisma, 'b');
      await h.prisma.category.update({ where: { id: other.category.id }, data: { name: 'Theirs' } });
      await h.prisma.taxGroup.update({ where: { id: other.taxGroup.id }, data: { name: 'Their tax' } });
      const result = await owner.post('/products/bulk', { rows: [row({ category: 'Theirs' }), row({ name: 'Other', taxGroup: 'Their tax' })] });
      // "Theirs" is a new category here, not the other restaurant's; their tax group does not exist here.
      expect(result.body).toMatchObject({ created: 1, errors: 1, newCategories: ['Theirs'] });
      expect(await h.prisma.product.count({ where: { categoryId: other.category.id } })).toBe(0);
    });

    it('deletes the chosen products in one go and frees their short codes', async () => {
      const [a, b, keep] = await Promise.all([
        owner.post('/products', product({ shortCode: 'PT' })), owner.post('/products', product({ name: 'Veg Roll', shortCode: 'VR' })),
        owner.post('/products', product({ name: 'Dal Tadka' })),
      ]).then((responses) => responses.map((r) => r.body as { id: string }));
      const other = await seedRestaurant(h.prisma, 'b');
      const otherOwner = h.client();
      await otherOwner.login(other.owner.email);
      const theirs = (await otherOwner.post('/products', { categoryId: other.category.id, name: 'Secret Dish', basePricePaise: 100 })).body;

      // Another restaurant's product and an id that does not exist are ignored.
      const result = await owner.post('/products/bulk-delete', { ids: [a!.id, b!.id, theirs.id, '00000000-0000-4000-8000-000000000000'] }).expect(200);
      expect(result.body).toEqual({ deleted: 2 });
      expect(await names()).toEqual(['Dal Tadka']);
      expect((await otherOwner.get(`/products/${theirs.id}`)).status).toBe(200);
      expect((await owner.get(`/products/${keep!.id}`)).status).toBe(200);
      await owner.post('/products', product({ name: 'Peri Tikka', shortCode: 'PT' })).expect(201);

      const entry = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'product.bulk_deleted' } });
      expect(entry.before).toMatchObject({ count: 2 });
      // Deleting them again finds nothing to delete.
      expect((await owner.post('/products/bulk-delete', { ids: [a!.id, b!.id] })).body).toEqual({ deleted: 0 });
    });
  });

  describe('images', () => {
    it('uploads an image, attaches it to a product and serves it publicly', async () => {
      const upload = await owner.agent.post('/api/v1/files/images')
        .set('Authorization', `Bearer ${owner.token}`).attach('file', PNG, 'anything.txt');
      expect(upload.status).toBe(201);
      expect(upload.body.key).toMatch(/^images\/[0-9a-f-]{36}\.png$/);

      const created = (await owner.post('/products', product({ imageKey: upload.body.key })).expect(201)).body;
      expect(created.imageUrl).toBe(upload.body.url);

      const image = await h.client().get(`/files/${upload.body.key}`);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(Buffer.compare(image.body, PNG)).toBe(0);
    });

    it('rejects a file that is not an image, whatever its name says', async () => {
      const upload = await owner.agent.post('/api/v1/files/images')
        .set('Authorization', `Bearer ${owner.token}`).attach('file', Buffer.from('<script>alert(1)</script>'), 'photo.png');
      expect(upload.status).toBe(422);
      expect(upload.body.code).toBe('UNSUPPORTED_IMAGE');
    });

    it('rejects uploads from users who cannot manage the menu, and path tricks when reading', async () => {
      const upload = await cashier.agent.post('/api/v1/files/images')
        .set('Authorization', `Bearer ${cashier.token}`).attach('file', PNG, 'a.png');
      expect(upload.status).toBe(403);
      expect((await h.client().get('/files/images/..%2F..%2F..%2F.env')).status).toBe(404);
      expect((await owner.post('/products', product({ imageKey: '../../.env' }))).status).toBe(400);
    });
  });
});
