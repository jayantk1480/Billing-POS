import { randomUUID } from 'node:crypto';
import { businessDateOf, financialYearOf } from '@pos/billing-core';
import { type Fixture, type Harness, type Menu, OWNER_PIN, PASSWORD, seedMenu, seedRestaurant, type TestClient } from './harness.js';

/** The financial year invoices issued right now fall in, as it appears in their numbers. */
export const FY = financialYearOf(businessDateOf(new Date()));

export interface Scene {
  fx: Fixture;
  menu: Menu;
  /** Signed in on terminal A1. */
  owner: TestClient;
  cashier: TestClient;
  /** The owner's sign-off, for actions a cashier cannot do alone. */
  ownerApproval: { userId: string; pin: string };
}

/** A restaurant with a menu, and an owner and cashier both signed in at the billing counter. */
export async function scene(h: Harness, tag = 'a'): Promise<Scene> {
  const fx = await seedRestaurant(h.prisma, tag);
  const menu = await seedMenu(h.prisma, fx);
  const owner = h.client();
  const cashier = h.client();
  await owner.login(fx.owner.email, PASSWORD, { client: 'pos', terminalId: fx.terminal.id });
  await cashier.login(fx.cashier.email, PASSWORD, { client: 'pos', terminalId: fx.terminal.id });
  return { fx, menu, owner, cashier, ownerApproval: { userId: fx.owner.id, pin: OWNER_PIN } };
}

export const line = (productId: string, quantity = 1, extra: object = {}) => ({ id: randomUUID(), productId, quantity, ...extra });

/** Saves an order and returns the response; `id` defaults to a new order. */
export function saveOrder(client: TestClient, body: object, id: string = randomUUID()) {
  return client.put(`/orders/${id}`, { type: 'TAKEAWAY', items: [], ...body });
}

/** Creates a takeaway order, bills it, and returns the single invoice. */
export async function billed(client: TestClient, items: object[], body: object = {}) {
  const order = (await saveOrder(client, { items, ...body }).expect(200)).body;
  const [invoice] = (await client.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
  return { order, invoice };
}

export const pay = (client: TestClient, invoiceId: string, payments: object[]) =>
  client.post(`/invoices/${invoiceId}/payments`, { payments: payments.map((p) => ({ id: randomUUID(), ...p })) });
