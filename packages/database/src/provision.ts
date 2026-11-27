import { PERMISSION_KEYS, PERMISSIONS, SYSTEM_ROLES } from '@pos/types';
import type { Prisma } from './generated/client.js';

export interface ProvisionInput {
  name: string;
  legalName?: string | null;
  gstin?: string | null;
  phone?: string | null;
  stateCode: string;
  stateName: string;
  gstRegistration: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
  /** When the free trial ends; null for no trial. */
  trialEndsAt: Date | null;
  createdVia: 'SIGNUP' | 'PLATFORM';
  owner: {
    name: string;
    email: string;
    passwordHash: string;
    phone?: string | null;
    /** Null when the owner still has to open the link sent to their email. */
    emailVerifiedAt: Date | null;
  };
}

/** GST slabs a restaurant usually needs. They are data: the owner can change them under Settings, Tax groups. */
const TAX_GROUPS: [string, number][] = [['GST 0%', 0], ['GST 5%', 500], ['GST 12%', 1200], ['GST 18%', 1800]];
const DEFAULT_TAX_GROUP = 'GST 5%';

/** Makes sure every permission the code knows about exists. Permissions are shared by all restaurants. */
export async function syncPermissions(db: Prisma.TransactionClient): Promise<Map<string, string>> {
  for (const key of PERMISSION_KEYS) {
    const { group, description } = PERMISSIONS[key];
    await db.permission.upsert({ where: { key }, update: { group, description }, create: { key, group, description } });
  }
  return new Map((await db.permission.findMany()).map((permission) => [permission.key, permission.id]));
}

/**
 * Creates a restaurant that is ready to bill: its settings, the standard roles, tax groups, one billing
 * terminal, one kitchen station and the owner's account. The menu, tables and staff are for the owner to add.
 * Run inside a transaction, so a restaurant is never left half made.
 */
export async function provisionRestaurant(db: Prisma.TransactionClient, input: ProvisionInput): Promise<{ restaurantId: string; ownerId: string }> {
  const permissionId = await syncPermissions(db);
  const restaurant = await db.restaurant.create({
    data: {
      name: input.name, legalName: input.legalName ?? null, gstin: input.gstin ?? null, phone: input.phone ?? null, email: input.owner.email,
      stateCode: input.stateCode, stateName: input.stateName, trialEndsAt: input.trialEndsAt, createdVia: input.createdVia,
    },
  });
  const restaurantId = restaurant.id;

  let defaultTaxGroupId: string | null = null;
  for (const [name, rateBps] of TAX_GROUPS) {
    const group = await db.taxGroup.create({
      data: {
        restaurantId, name,
        components: {
          create: [
            { type: 'CGST', name: 'CGST', rateBps: rateBps / 2 },
            { type: 'SGST', name: 'SGST', rateBps: rateBps / 2 },
            { type: 'IGST', name: 'IGST', rateBps },
          ],
        },
      },
    });
    if (name === DEFAULT_TAX_GROUP) defaultTaxGroupId = group.id;
  }
  await db.restaurantSettings.create({ data: { restaurantId, gstRegistration: input.gstRegistration, defaultTaxGroupId } });

  let ownerRoleId = '';
  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    const created = await db.role.create({
      data: { restaurantId, key, name: role.name, isSystem: true, permissions: { create: role.permissions.map((permission) => ({ permissionId: permissionId.get(permission)! })) } },
    });
    if (key === 'owner') ownerRoleId = created.id;
  }

  const owner = await db.user.create({
    data: {
      restaurantId, roleId: ownerRoleId, name: input.owner.name, email: input.owner.email, phone: input.owner.phone ?? null,
      passwordHash: input.owner.passwordHash, emailVerifiedAt: input.owner.emailVerifiedAt,
    },
  });
  await db.terminal.create({ data: { restaurantId, code: 'A1', name: 'Counter 1' } });
  await db.kitchenStation.create({ data: { restaurantId, name: 'Kitchen' } });
  return { restaurantId, ownerId: owner.id };
}
