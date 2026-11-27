import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@pos/database';
import { PERMISSION_KEYS, PERMISSIONS, SYSTEM_ROLES } from '@pos/types';
import argon2 from 'argon2';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { REDIS } from '../../src/modules/redis/redis.module.js';
import { setupApp } from '../../src/setup-app.js';

export const ORIGIN = 'http://localhost:3100';
export const PASSWORD = 'correct horse battery';
export const OWNER_PIN = '4821';
export const CASHIER_PIN = '7350';

export interface Harness {
  app: NestExpressApplication;
  prisma: PrismaClient;
  redis: Redis;
  /** Empties the database and Redis so each test starts clean. */
  reset(): Promise<void>;
  client(): TestClient;
  /** Starts listening on a free port (needed for WebSocket tests) and returns the base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  setupApp(app);
  await app.init();
  const prisma = app.get(PrismaClient);
  const redis = app.get<Redis>(REDIS);
  let listening: Promise<string> | undefined;

  return {
    app,
    prisma,
    redis,
    async reset() {
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
      await redis.flushdb();
    },
    client: () => new TestClient(app),
    async listen() {
      listening ??= app.listen(0).then(() => app.getUrl()).then((url) => url.replace('[::1]', 'localhost'));
      return listening;
    },
    close: () => app.close(),
  };
}

/** A browser-like API client: keeps cookies, sends the Origin header and the access token. */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  token: string | null = null;

  constructor(app: NestExpressApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  async login(email: string, password = PASSWORD, extra: Record<string, unknown> = {}) {
    const response = await this.agent.post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password, client: 'web', ...extra });
    if (response.status === 200) this.token = response.body.accessToken;
    return response;
  }

  /** Signs in on the billing screen, which is where accounts without back-office access belong. */
  loginPos = (email: string, password = PASSWORD, extra: Record<string, unknown> = {}) => this.login(email, password, { client: 'pos', ...extra });

  get = (path: string) => this.prepare(this.agent.get(`/api/v1${path}`));
  post = (path: string, body?: object) => this.prepare(this.agent.post(`/api/v1${path}`)).send(body);
  patch = (path: string, body?: object) => this.prepare(this.agent.patch(`/api/v1${path}`)).send(body);
  put = (path: string, body?: object) => this.prepare(this.agent.put(`/api/v1${path}`)).send(body);
  delete = (path: string) => this.prepare(this.agent.delete(`/api/v1${path}`));

  private prepare<T extends request.Test>(req: T): T {
    req.set('Origin', ORIGIN);
    if (this.token) req.set('Authorization', `Bearer ${this.token}`);
    return req;
  }
}

export type Fixture = Awaited<ReturnType<typeof seedRestaurant>>;

/** Creates one restaurant with the built-in roles, an owner, a cashier and the minimum menu setup. */
export async function seedRestaurant(prisma: PrismaClient, tag = 'a') {
  for (const key of PERMISSION_KEYS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key, ...PERMISSIONS[key] } });
  }
  const permissionId = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));

  const restaurant = await prisma.restaurant.create({
    data: { name: `Test Restaurant ${tag.toUpperCase()}`, gstin: '27AAAAA0000A1Z5', stateCode: '27', stateName: 'Maharashtra' },
  });
  const restaurantId = restaurant.id;
  const taxGroup = await prisma.taxGroup.create({
    data: {
      restaurantId, name: 'GST 5%',
      components: { create: [{ type: 'CGST', name: 'CGST', rateBps: 250 }, { type: 'SGST', name: 'SGST', rateBps: 250 }, { type: 'IGST', name: 'IGST', rateBps: 500 }] },
    },
  });
  await prisma.restaurantSettings.create({ data: { restaurantId, defaultTaxGroupId: taxGroup.id } });

  const roles: Record<string, string> = {};
  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    const created = await prisma.role.create({
      data: {
        restaurantId, key, name: role.name, isSystem: true,
        permissions: { create: role.permissions.map((p) => ({ permissionId: permissionId.get(p)! })) },
      },
    });
    roles[key] = created.id;
  }

  // Low-cost hashing keeps the suite fast; production parameters are covered by the login tests themselves.
  const hash = (secret: string) => argon2.hash(secret, { type: argon2.argon2id, memoryCost: 1024, timeCost: 2 });
  const owner = await prisma.user.create({
    data: { restaurantId, roleId: roles.owner!, name: 'Owner', email: `owner-${tag}@test.local`, passwordHash: await hash(PASSWORD), pinHash: await hash(OWNER_PIN) },
  });
  const cashier = await prisma.user.create({
    data: { restaurantId, roleId: roles.cashier!, name: 'Cashier', email: `cashier-${tag}@test.local`, passwordHash: await hash(PASSWORD), pinHash: await hash(CASHIER_PIN) },
  });
  const terminal = await prisma.terminal.create({ data: { restaurantId, code: 'A1', name: 'Counter 1' } });
  const station = await prisma.kitchenStation.create({ data: { restaurantId, name: 'Main Kitchen' } });
  const category = await prisma.category.create({ data: { restaurantId, name: 'Starters' } });

  return { restaurant, roles, owner, cashier, terminal, station, category, taxGroup };
}

export type Menu = Awaited<ReturnType<typeof seedMenu>>;

/** A small menu and two tables, covering plain items, variants, modifiers and a second tax rate. */
export async function seedMenu(prisma: PrismaClient, fx: Fixture) {
  const restaurantId = fx.restaurant.id;
  const base = { restaurantId, categoryId: fx.category.id };
  const gst18 = await prisma.taxGroup.create({
    data: {
      restaurantId, name: 'GST 18%',
      components: { create: [{ type: 'CGST', name: 'CGST', rateBps: 900 }, { type: 'SGST', name: 'SGST', rateBps: 900 }, { type: 'IGST', name: 'IGST', rateBps: 1800 }] },
    },
  });
  // No tax group of their own: these use the restaurant default (GST 5%).
  const paneer = await prisma.product.create({ data: { ...base, name: 'Paneer Tikka', shortCode: 'PT', basePricePaise: 26000, hsnSac: '996331' } });
  const cola = await prisma.product.create({ data: { ...base, name: 'Cola', basePricePaise: 5000, taxGroupId: gst18.id } });
  const chicken = await prisma.product.create({
    data: {
      ...base, name: 'Tandoori Chicken', basePricePaise: 28000, foodType: 'NON_VEG',
      variants: { create: [{ name: 'Half', pricePaise: 28000, isDefault: true }, { name: 'Full', pricePaise: 52000, sortOrder: 1 }] },
    },
    include: { variants: { orderBy: { sortOrder: 'asc' } } },
  });
  const addOns = await prisma.modifierGroup.create({
    data: { restaurantId, name: 'Add-ons', minSelect: 0, maxSelect: 2, modifiers: { create: [{ name: 'Raita', pricePaise: 4000 }, { name: 'Boiled Egg', pricePaise: 2500, sortOrder: 1 }] } },
    include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
  });
  const spice = await prisma.modifierGroup.create({
    data: { restaurantId, name: 'Spice Level', minSelect: 1, maxSelect: 1, modifiers: { create: [{ name: 'Mild' }, { name: 'Spicy', sortOrder: 1 }] } },
    include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
  });
  const biryani = await prisma.product.create({
    data: {
      ...base, name: 'Veg Biryani', basePricePaise: 25000,
      modifierGroups: { create: [{ modifierGroupId: addOns.id }, { modifierGroupId: spice.id, sortOrder: 1 }] },
    },
  });
  const area = await prisma.area.create({ data: { restaurantId, name: 'Main Hall' } });
  const t1 = await prisma.diningTable.create({ data: { restaurantId, areaId: area.id, name: 'T1' } });
  const t2 = await prisma.diningTable.create({ data: { restaurantId, areaId: area.id, name: 'T2' } });
  return {
    gst18, paneer, cola, chicken, half: chicken.variants[0]!, full: chicken.variants[1]!, biryani,
    raita: addOns.modifiers[0]!, egg: addOns.modifiers[1]!, mild: spice.modifiers[0]!, spicy: spice.modifiers[1]!, t1, t2,
  };
}

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/**
 * Reads the mail captured by Mailpit. The mailbox is shared with the development stack,
 * so this only ever looks at, and deletes, messages sent to the test domain.
 */
export const mailbox = {
  url: process.env.MAILPIT_URL ?? 'http://localhost:8025',
  domain: '@test.local',
  async list(): Promise<MailSummary[]> {
    const response = await fetch(`${this.url}/api/v1/messages?limit=200`);
    const body = (await response.json()) as { messages: MailSummary[] };
    return body.messages.filter((message) => message.To.some((to) => to.Address.endsWith(this.domain)));
  },
  async clear(): Promise<void> {
    const ids = (await this.list()).map((message) => message.ID);
    if (ids.length === 0) return;
    await fetch(`${this.url}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IDs: ids }),
    });
  },
  async latestTo(address: string): Promise<{ subject: string; text: string } | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const found = (await this.list()).find((message) => message.To.some((to) => to.Address === address));
      if (found) {
        const full = (await (await fetch(`${this.url}/api/v1/message/${found.ID}`)).json()) as { Text: string };
        return { subject: found.Subject, text: full.Text };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  },
};
