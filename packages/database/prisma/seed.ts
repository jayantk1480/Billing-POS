/**
 * Loads a demo restaurant: permissions, roles, two users, tax groups, kitchen stations,
 * floor, and a sample menu. Safe to run twice: it stops if a restaurant already exists.
 * Also creates the first platform admin (the vendor's own sign-in to the admin app) if there is none.
 * Account credentials come from SEED_* and PLATFORM_ADMIN_* environment variables, never from this file.
 */
import path from 'node:path';
import argon2 from 'argon2';
import { PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES } from '@pos/types';
import { createPrismaClient, type FoodType } from '../src/index.js';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // Variables are already in the environment.
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value === 'change-me') throw new Error(`Set ${name} in .env before seeding`);
  return value;
}

const prisma = createPrismaClient(requireEnv('DATABASE_URL'));
const rupees = (value: number) => Math.round(value * 100);

type SeedProduct = {
  name: string;
  code: string;
  price: number;
  food?: FoodType;
  station: string;
  tax?: string;
  variants?: [string, number][];
  modifierGroups?: string[];
  favourite?: boolean;
};

const MENU: Record<string, SeedProduct[]> = {
  Starters: [
    { name: 'Paneer Tikka', code: 'PT', price: 260, station: 'Tandoor', modifierGroups: ['Spice Level'], favourite: true },
    { name: 'Hara Bhara Kebab', code: 'HBK', price: 220, station: 'Tandoor' },
    { name: 'Veg Spring Roll', code: 'VSR', price: 190, station: 'Main Kitchen' },
    { name: 'Chicken Tikka', code: 'CT', price: 320, food: 'NON_VEG', station: 'Tandoor', modifierGroups: ['Spice Level'], favourite: true },
    { name: 'Tandoori Chicken', code: 'TC', price: 280, food: 'NON_VEG', station: 'Tandoor', variants: [['Half', 280], ['Full', 520]] },
    { name: 'Fish Amritsari', code: 'FA', price: 360, food: 'NON_VEG', station: 'Main Kitchen' },
    { name: 'Masala Papad', code: 'MP', price: 60, station: 'Main Kitchen' },
  ],
  'Main Course': [
    { name: 'Paneer Butter Masala', code: 'PBM', price: 290, station: 'Main Kitchen', modifierGroups: ['Spice Level'], favourite: true },
    { name: 'Dal Makhani', code: 'DM', price: 240, station: 'Main Kitchen', favourite: true },
    { name: 'Dal Tadka', code: 'DT', price: 190, station: 'Main Kitchen' },
    { name: 'Mix Veg', code: 'MV', price: 220, station: 'Main Kitchen' },
    { name: 'Kadai Paneer', code: 'KP', price: 280, station: 'Main Kitchen', modifierGroups: ['Spice Level'] },
    { name: 'Butter Chicken', code: 'BC', price: 340, food: 'NON_VEG', station: 'Main Kitchen', variants: [['Half', 340], ['Full', 620]], modifierGroups: ['Spice Level'], favourite: true },
    { name: 'Chicken Curry', code: 'CC', price: 310, food: 'NON_VEG', station: 'Main Kitchen' },
    { name: 'Mutton Rogan Josh', code: 'MRJ', price: 420, food: 'NON_VEG', station: 'Main Kitchen' },
    { name: 'Egg Curry', code: 'EC', price: 210, food: 'EGG', station: 'Main Kitchen' },
  ],
  Breads: [
    { name: 'Tandoori Roti', code: 'TR', price: 25, station: 'Tandoor', modifierGroups: ['Bread Options'] },
    { name: 'Butter Naan', code: 'BN', price: 55, station: 'Tandoor', favourite: true },
    { name: 'Garlic Naan', code: 'GN', price: 70, station: 'Tandoor' },
    { name: 'Lachha Paratha', code: 'LP', price: 60, station: 'Tandoor' },
    { name: 'Stuffed Kulcha', code: 'SK', price: 90, station: 'Tandoor' },
  ],
  'Rice & Biryani': [
    { name: 'Steamed Rice', code: 'SR', price: 130, station: 'Main Kitchen' },
    { name: 'Jeera Rice', code: 'JR', price: 160, station: 'Main Kitchen' },
    { name: 'Veg Biryani', code: 'VB', price: 250, station: 'Main Kitchen', modifierGroups: ['Add-ons'] },
    { name: 'Chicken Biryani', code: 'CB', price: 320, food: 'NON_VEG', station: 'Main Kitchen', modifierGroups: ['Add-ons'], favourite: true },
    { name: 'Mutton Biryani', code: 'MB', price: 400, food: 'NON_VEG', station: 'Main Kitchen', modifierGroups: ['Add-ons'] },
    { name: 'Egg Biryani', code: 'EB', price: 270, food: 'EGG', station: 'Main Kitchen', modifierGroups: ['Add-ons'] },
  ],
  Chinese: [
    { name: 'Veg Hakka Noodles', code: 'VHN', price: 210, station: 'Main Kitchen' },
    { name: 'Veg Fried Rice', code: 'VFR', price: 200, station: 'Main Kitchen' },
    { name: 'Veg Manchurian', code: 'VM', price: 220, station: 'Main Kitchen', variants: [['Dry', 220], ['Gravy', 240]] },
    { name: 'Chilli Chicken', code: 'CHC', price: 290, food: 'NON_VEG', station: 'Main Kitchen', variants: [['Dry', 290], ['Gravy', 310]] },
    { name: 'Chicken Fried Rice', code: 'CFR', price: 250, food: 'NON_VEG', station: 'Main Kitchen' },
  ],
  Beverages: [
    { name: 'Masala Tea', code: 'MT', price: 40, station: 'Beverages', favourite: true },
    { name: 'Filter Coffee', code: 'FC', price: 60, station: 'Beverages' },
    { name: 'Sweet Lassi', code: 'SL', price: 90, station: 'Beverages', variants: [['Regular', 90], ['Large', 130]] },
    { name: 'Fresh Lime Soda', code: 'FLS', price: 90, station: 'Beverages', variants: [['Sweet', 90], ['Salted', 90]] },
    { name: 'Buttermilk', code: 'BM', price: 60, station: 'Beverages' },
    { name: 'Mineral Water 1L', code: 'MW', price: 30, station: 'Beverages', tax: 'GST 18%' },
    { name: 'Soft Drink 300ml', code: 'SD', price: 50, station: 'Beverages', tax: 'GST 18%' },
  ],
  Desserts: [
    { name: 'Gulab Jamun (2 pc)', code: 'GJ', price: 90, station: 'Main Kitchen' },
    { name: 'Rasmalai (2 pc)', code: 'RM', price: 120, station: 'Main Kitchen' },
    { name: 'Gajar Halwa', code: 'GH', price: 130, station: 'Main Kitchen' },
    { name: 'Kulfi', code: 'KF', price: 100, station: 'Beverages' },
  ],
};

const MODIFIER_GROUPS: Record<string, { min: number; max: number; options: [string, number][] }> = {
  'Spice Level': { min: 0, max: 1, options: [['Mild', 0], ['Medium', 0], ['Spicy', 0]] },
  'Add-ons': { min: 0, max: 3, options: [['Extra Raita', 40], ['Extra Salan', 30], ['Boiled Egg', 25]] },
  'Bread Options': { min: 0, max: 1, options: [['With Butter', 10], ['Without Butter', 0]] },
};

const CATEGORY_COLORS = ['#f97316', '#dc2626', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#9333ea'];

/** The vendor's first sign-in to the admin app. Further admins are a matter for that app, not for this script. */
async function seedPlatformAdmin() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password || password === 'change-me') {
    console.log('PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are not set; no platform admin created.');
    return;
  }
  if ((await prisma.platformAdmin.count()) > 0) return;
  if (password.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  await prisma.platformAdmin.create({
    data: { email, name: process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform admin', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
  });
  console.log('Created platform admin ' + email);
}

async function main() {
  await seedPlatformAdmin();
  if ((await prisma.restaurant.count()) > 0) {
    console.log('A restaurant already exists; seed skipped.');
    return;
  }

  // Permissions are global and safe to upsert.
  for (const key of PERMISSION_KEYS) {
    const { group, description } = PERMISSIONS[key];
    await prisma.permission.upsert({ where: { key }, update: { group, description }, create: { key, group, description } });
  }
  const permissions = await prisma.permission.findMany();
  const permissionId = new Map(permissions.map((p) => [p.key, p.id]));

  const restaurant = await prisma.restaurant.create({
    data: {
      name: 'Demo Restaurant',
      legalName: 'Demo Foods Private Limited',
      gstin: '27AAAAA0000A1Z5', // placeholder in valid format; replace in Settings
      fssaiNumber: '00000000000000',
      phone: '0000000000',
      addressLine1: '1 Sample Street',
      city: 'Mumbai',
      stateCode: '27',
      stateName: 'Maharashtra',
      pincode: '400001',
      // The demo restaurant arrives fully set up, so it has no getting-started list.
      onboardingDismissedAt: new Date(),
    },
  });
  const restaurantId = restaurant.id;

  // Tax groups: rates are data, set here only as a sensible starting point.
  const taxGroupId = new Map<string, string>();
  for (const [name, totalBps] of [['GST 0%', 0], ['GST 5%', 500], ['GST 18%', 1800]] as const) {
    const group = await prisma.taxGroup.create({
      data: {
        restaurantId,
        name,
        components: {
          create: [
            { type: 'CGST', name: 'CGST', rateBps: totalBps / 2 },
            { type: 'SGST', name: 'SGST', rateBps: totalBps / 2 },
            { type: 'IGST', name: 'IGST', rateBps: totalBps },
          ],
        },
      },
    });
    taxGroupId.set(name, group.id);
  }

  await prisma.restaurantSettings.create({
    data: {
      restaurantId,
      defaultTaxGroupId: taxGroupId.get('GST 5%'),
      invoiceFooter: 'Thank you. Please visit again.',
    },
  });

  // Roles.
  const roleId = new Map<string, string>();
  for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
    const created = await prisma.role.create({
      data: {
        restaurantId,
        key,
        name: role.name,
        isSystem: true,
        permissions: { create: role.permissions.map((p) => ({ permissionId: permissionId.get(p)! })) },
      },
    });
    roleId.set(key, created.id);
  }

  // Users.
  const hash = (secret: string) => argon2.hash(secret, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      restaurantId,
      roleId: roleId.get('owner')!,
      name: 'Owner',
      email: requireEnv('SEED_OWNER_EMAIL').toLowerCase(),
      passwordHash: await hash(requireEnv('SEED_OWNER_PASSWORD')),
      pinHash: await hash(requireEnv('SEED_OWNER_PIN')),
    },
  });
  await prisma.user.create({
    data: {
      restaurantId,
      roleId: roleId.get('cashier')!,
      name: 'Cashier',
      email: requireEnv('SEED_CASHIER_EMAIL').toLowerCase(),
      passwordHash: await hash(requireEnv('SEED_CASHIER_PASSWORD')),
      pinHash: await hash(requireEnv('SEED_CASHIER_PIN')),
    },
  });

  await prisma.terminal.create({ data: { restaurantId, code: 'A1', name: 'Counter 1' } });

  // Kitchen stations.
  const stationId = new Map<string, string>();
  for (const [index, name] of ['Main Kitchen', 'Tandoor', 'Beverages'].entries()) {
    const station = await prisma.kitchenStation.create({ data: { restaurantId, name, sortOrder: index } });
    stationId.set(name, station.id);
  }

  // Floor: tables laid out on a simple grid the floor editor can rearrange.
  for (const [areaIndex, [areaName, count, prefix]] of ([['Ground Floor', 8, 'T'], ['Terrace', 4, 'R']] as const).entries()) {
    const area = await prisma.area.create({ data: { restaurantId, name: areaName, sortOrder: areaIndex } });
    await prisma.diningTable.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        restaurantId,
        areaId: area.id,
        name: `${prefix}${i + 1}`,
        seats: i % 4 === 3 ? 6 : 4,
        shape: i % 4 === 3 ? ('RECTANGLE' as const) : ('SQUARE' as const),
        posX: 40 + (i % 4) * 160,
        posY: 40 + Math.floor(i / 4) * 160,
        width: i % 4 === 3 ? 128 : 96,
      })),
    });
  }

  // Modifier groups.
  const modifierGroupId = new Map<string, string>();
  for (const [name, group] of Object.entries(MODIFIER_GROUPS)) {
    const created = await prisma.modifierGroup.create({
      data: {
        restaurantId,
        name,
        minSelect: group.min,
        maxSelect: group.max,
        modifiers: {
          create: group.options.map(([optionName, price], sortOrder) => ({
            name: optionName,
            pricePaise: rupees(price),
            sortOrder,
          })),
        },
      },
    });
    modifierGroupId.set(name, created.id);
  }

  // Menu.
  let productCount = 0;
  for (const [categoryIndex, [categoryName, products]] of Object.entries(MENU).entries()) {
    const category = await prisma.category.create({
      data: { restaurantId, name: categoryName, sortOrder: categoryIndex, color: CATEGORY_COLORS[categoryIndex] },
    });
    for (const [sortOrder, product] of products.entries()) {
      await prisma.product.create({
        data: {
          restaurantId,
          categoryId: category.id,
          taxGroupId: taxGroupId.get(product.tax ?? 'GST 5%'),
          stationId: stationId.get(product.station),
          name: product.name,
          shortCode: product.code,
          foodType: product.food ?? 'VEG',
          basePricePaise: rupees(product.price),
          hsnSac: '996331', // restaurant service; editable per product
          isFavourite: product.favourite ?? false,
          sortOrder,
          variants: product.variants && {
            create: product.variants.map(([name, price], index) => ({
              name,
              pricePaise: rupees(price),
              sortOrder: index,
              isDefault: index === 0,
            })),
          },
          modifierGroups: product.modifierGroups && {
            create: product.modifierGroups.map((name, index) => ({
              modifierGroupId: modifierGroupId.get(name)!,
              sortOrder: index,
            })),
          },
        },
      });
      productCount += 1;
    }
  }

  console.log(
    `Seeded "${restaurant.name}": ${permissions.length} permissions, ${roleId.size} roles, 2 users, ` +
      `${taxGroupId.size} tax groups, ${stationId.size} stations, 12 tables, ${productCount} products.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
