import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import type {
  BulkProductRowResult, bulkProductsSchema, BulkProductsResult, CategoryDto, categorySchema, createProductSchema, FoodType, ModifierGroupDto,
  modifierGroupSchema, Page, ProductDto, productQuerySchema, updateCategorySchema, updateProductSchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../files/storage.service.js';

const productInclude = {
  category: { select: { name: true } },
  variants: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
  modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { modifierGroupId: true } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const groupInclude = {
  modifiers: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
  _count: { select: { products: { where: { product: { deletedAt: null } } } } },
} satisfies Prisma.ModifierGroupInclude;
type GroupRow = Prisma.ModifierGroupGetPayload<{ include: typeof groupInclude }>;

type ProductInput = z.output<typeof createProductSchema>;
type ProductPatch = z.output<typeof updateProductSchema>;
type VariantInput = ProductInput['variants'][number];
type BulkInput = z.output<typeof bulkProductsSchema>;
type BulkRow = BulkInput['rows'][number];

const FOOD_TYPES: Record<string, FoodType> = {
  '': 'VEG', veg: 'VEG', vegetarian: 'VEG', nonveg: 'NON_VEG', nonvegetarian: 'NON_VEG', egg: 'EGG', eggetarian: 'EGG',
};

/** "260", "260.5", "₹1,250.00" or "Rs. 260" as paise; null when the text is not an amount. */
function rupeesToPaise(text: string): number | null {
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text.replace(/^(₹|rs\.?|inr)/i, '').replace(/[,\s]/g, ''));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}

/** Reads one spreadsheet row. Category and tax group stay as names here; they are matched against the menu afterwards. */
function readBulkRow(row: BulkRow): { problems: string[]; pricePaise: number; shortCode: string | null; foodType: FoodType; hsnSac: string | null } {
  const problems: string[] = [];
  if (!row.name) problems.push('Name is missing');
  else if (row.name.length > 120) problems.push('Name must be at most 120 characters');
  if (!row.category) problems.push('Category is missing');
  else if (row.category.length > 60) problems.push('Category must be at most 60 characters');

  const pricePaise = rupeesToPaise(row.price);
  if (!row.price) problems.push('Price is missing');
  else if (pricePaise === null) problems.push(`"${row.price}" is not a price`);

  const shortCode = row.shortCode.toUpperCase() || null;
  if (shortCode && !/^[A-Z0-9]{1,8}$/.test(shortCode)) problems.push('Short code can have up to 8 letters or digits');

  const foodType = FOOD_TYPES[row.foodType.toLowerCase().replace(/[^a-z]/g, '')];
  if (!foodType) problems.push(`Type "${row.foodType}" is not veg, non-veg or egg`);

  if (row.description.length > 500) problems.push('Description must be at most 500 characters');
  if (row.hsnSac && !/^\d{4,8}$/.test(row.hsnSac)) problems.push('HSN/SAC has 4 to 8 digits');
  return { problems, pricePaise: pricePaise ?? 0, shortCode, foodType: foodType ?? 'VEG', hsnSac: row.hsnSac || null };
}

const toGroupDto = (group: GroupRow): ModifierGroupDto => ({
  id: group.id,
  name: group.name,
  minSelect: group.minSelect,
  maxSelect: group.maxSelect,
  isActive: group.isActive,
  modifiers: group.modifiers.map((m) => ({
    id: m.id, name: m.name, pricePaise: m.pricePaise, isAvailable: m.isAvailable, sortOrder: m.sortOrder,
  })),
  productCount: group._count.products,
});

function assertDistinctNames(items: { name: string }[], what: string): void {
  const names = items.map((item) => item.name.toLowerCase());
  if (new Set(names).size !== names.length) throw invalid('DUPLICATE_NAME', `Each ${what} needs a different name.`);
}

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Categories ──

  async listCategories(auth: AuthContext): Promise<CategoryDto[]> {
    const categories = await this.prisma.category.findMany({
      where: { restaurantId: auth.restaurantId, deletedAt: null },
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories.map((c) => ({
      id: c.id, name: c.name, color: c.color, sortOrder: c.sortOrder, isActive: c.isActive, productCount: c._count.products,
    }));
  }

  async createCategory(auth: AuthContext, input: z.output<typeof categorySchema>): Promise<CategoryDto> {
    await this.assertCategoryNameFree(auth, input.name);
    const last = await this.prisma.category.aggregate({
      where: { restaurantId: auth.restaurantId, deletedAt: null }, _max: { sortOrder: true },
    });
    const category = await this.prisma.category.create({
      data: {
        restaurantId: auth.restaurantId, name: input.name, color: input.color ?? null, isActive: input.isActive,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    await this.audit.record(auth, { action: 'category.created', entityType: 'category', entityId: category.id, after: category });
    return { id: category.id, name: category.name, color: category.color, sortOrder: category.sortOrder, isActive: category.isActive, productCount: 0 };
  }

  async updateCategory(auth: AuthContext, id: string, input: z.output<typeof updateCategorySchema>): Promise<CategoryDto> {
    const before = await this.findCategory(auth, id);
    if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) await this.assertCategoryNameFree(auth, input.name);
    const category = await this.prisma.category.update({ where: { id }, data: input });
    await this.audit.record(auth, { action: 'category.updated', entityType: 'category', entityId: id, before, after: category });
    return (await this.listCategories(auth)).find((c) => c.id === id)!;
  }

  async deleteCategory(auth: AuthContext, id: string): Promise<void> {
    const category = await this.findCategory(auth, id);
    const products = await this.prisma.product.count({ where: { categoryId: id, deletedAt: null } });
    if (products > 0) {
      throw conflict('CATEGORY_NOT_EMPTY', `Move or delete the ${products} product(s) in "${category.name}" first.`);
    }
    await this.prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record(auth, { action: 'category.deleted', entityType: 'category', entityId: id, before: category });
  }

  /** Sets the display order to the order of `ids`, which must list every category exactly once. */
  async reorderCategories(auth: AuthContext, ids: string[]): Promise<CategoryDto[]> {
    const existing = await this.prisma.category.findMany({
      where: { restaurantId: auth.restaurantId, deletedAt: null }, select: { id: true },
    });
    const known = new Set(existing.map((c) => c.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw invalid('REORDER_MISMATCH', 'The category list has changed. Refresh and try again.');
    }
    await this.prisma.$transaction(ids.map((id, sortOrder) => this.prisma.category.update({ where: { id }, data: { sortOrder } })));
    await this.audit.record(auth, { action: 'category.reordered', entityType: 'category', after: { ids } });
    return this.listCategories(auth);
  }

  private async findCategory(auth: AuthContext, id: string) {
    const category = await this.prisma.category.findFirst({ where: { id, restaurantId: auth.restaurantId, deletedAt: null } });
    if (!category) throw notFound('Category');
    return category;
  }

  private async assertCategoryNameFree(auth: AuthContext, name: string): Promise<void> {
    const clash = await this.prisma.category.findFirst({
      where: { restaurantId: auth.restaurantId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
    });
    if (clash) throw conflict('NAME_TAKEN', `A category named "${name}" already exists.`);
  }

  // ── Modifier groups ──

  async listModifierGroups(auth: AuthContext): Promise<ModifierGroupDto[]> {
    const groups = await this.prisma.modifierGroup.findMany({
      where: { restaurantId: auth.restaurantId, deletedAt: null }, include: groupInclude, orderBy: { name: 'asc' },
    });
    return groups.map(toGroupDto);
  }

  async createModifierGroup(auth: AuthContext, input: z.output<typeof modifierGroupSchema>): Promise<ModifierGroupDto> {
    assertDistinctNames(input.modifiers, 'option');
    const group = await this.prisma.modifierGroup.create({
      data: {
        restaurantId: auth.restaurantId, name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect,
        isActive: input.isActive,
        modifiers: {
          create: input.modifiers.map((m, sortOrder) => ({ name: m.name, pricePaise: m.pricePaise, isAvailable: m.isAvailable, sortOrder })),
        },
      },
      include: groupInclude,
    });
    await this.audit.record(auth, { action: 'modifier_group.created', entityType: 'modifier_group', entityId: group.id, after: toGroupDto(group) });
    return toGroupDto(group);
  }

  async updateModifierGroup(auth: AuthContext, id: string, input: z.output<typeof modifierGroupSchema>): Promise<ModifierGroupDto> {
    const before = await this.findModifierGroup(auth, id);
    assertDistinctNames(input.modifiers, 'option');
    const existingIds = new Set(before.modifiers.map((m) => m.id));
    if (input.modifiers.some((m) => m.id && !existingIds.has(m.id))) throw invalid('UNKNOWN_OPTION', 'An option in this list no longer exists. Refresh and try again.');
    const keptIds = input.modifiers.flatMap((m) => (m.id ? [m.id] : []));

    const updated = await this.prisma.$transaction(async (tx) => {
      // Options are soft-deleted so past orders that used them still read correctly.
      await tx.modifier.updateMany({ where: { groupId: id, deletedAt: null, id: { notIn: keptIds } }, data: { deletedAt: new Date() } });
      for (const [sortOrder, m] of input.modifiers.entries()) {
        const data = { name: m.name, pricePaise: m.pricePaise, isAvailable: m.isAvailable, sortOrder };
        if (m.id) await tx.modifier.update({ where: { id: m.id }, data });
        else await tx.modifier.create({ data: { groupId: id, ...data } });
      }
      return tx.modifierGroup.update({
        where: { id },
        data: { name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect, isActive: input.isActive },
        include: groupInclude,
      });
    });
    await this.audit.record(auth, {
      action: 'modifier_group.updated', entityType: 'modifier_group', entityId: id, before: toGroupDto(before), after: toGroupDto(updated),
    });
    return toGroupDto(updated);
  }

  async deleteModifierGroup(auth: AuthContext, id: string): Promise<void> {
    const group = await this.findModifierGroup(auth, id);
    await this.prisma.$transaction([
      this.prisma.productModifierGroup.deleteMany({ where: { modifierGroupId: id } }),
      this.prisma.modifierGroup.update({ where: { id }, data: { deletedAt: new Date() } }),
    ]);
    await this.audit.record(auth, { action: 'modifier_group.deleted', entityType: 'modifier_group', entityId: id, before: toGroupDto(group) });
  }

  private async findModifierGroup(auth: AuthContext, id: string): Promise<GroupRow> {
    const group = await this.prisma.modifierGroup.findFirst({
      where: { id, restaurantId: auth.restaurantId, deletedAt: null }, include: groupInclude,
    });
    if (!group) throw notFound('Modifier group');
    return group;
  }

  // ── Products ──

  async listProducts(auth: AuthContext, query: z.output<typeof productQuerySchema>): Promise<Page<ProductDto>> {
    const where: Prisma.ProductWhereInput = {
      restaurantId: auth.restaurantId,
      deletedAt: null,
      categoryId: query.categoryId,
      isAvailable: query.availability === undefined ? undefined : query.availability === 'available',
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { shortCode: { equals: query.search.toUpperCase() } }] }
        : {}),
    };
    const direction = query.direction;
    const sortColumns: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
      product: [{ name: direction }],
      category: [{ category: { name: direction } }],
      price: [{ basePricePaise: direction }],
      tax: [{ taxGroup: { name: direction } }],
      available: [{ isAvailable: direction }],
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        include: productInclude,
        orderBy: [...(query.sort ? sortColumns[query.sort]! : []), { category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map((row) => this.toProductDto(row)), total, page: query.page, pageSize: query.pageSize };
  }

  /** Every product that can appear on the billing screen, in menu order. */
  async sellableProducts(auth: AuthContext): Promise<ProductDto[]> {
    const rows = await this.prisma.product.findMany({
      where: { restaurantId: auth.restaurantId, deletedAt: null, isActive: true, category: { isActive: true, deletedAt: null } },
      include: productInclude,
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((row) => this.toProductDto(row));
  }

  async getProduct(auth: AuthContext, id: string): Promise<ProductDto> {
    return this.toProductDto(await this.findProduct(auth, id));
  }

  async createProduct(auth: AuthContext, input: ProductInput): Promise<ProductDto> {
    await this.assertProductReferences(auth, input);
    if (input.shortCode) await this.assertShortCodeFree(auth, input.shortCode);
    assertDistinctNames(input.variants, 'variant');

    const last = await this.prisma.product.aggregate({
      where: { restaurantId: auth.restaurantId, categoryId: input.categoryId, deletedAt: null }, _max: { sortOrder: true },
    });
    const product = await this.prisma.product.create({
      data: {
        restaurantId: auth.restaurantId,
        categoryId: input.categoryId,
        name: input.name,
        shortCode: input.shortCode ?? null,
        description: input.description ?? null,
        foodType: input.foodType,
        // With variants, the first variant is the default and its price is the product's headline price.
        basePricePaise: input.variants[0]?.pricePaise ?? input.basePricePaise,
        taxGroupId: input.taxGroupId ?? null,
        priceIncludesTax: input.priceIncludesTax ?? null,
        hsnSac: input.hsnSac ?? null,
        stationId: input.stationId ?? null,
        sendToKitchen: input.sendToKitchen,
        isAvailable: input.isAvailable,
        isActive: input.isActive,
        isFavourite: input.isFavourite,
        imageUrl: input.imageKey ?? null,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
        variants: { create: input.variants.map((v, index) => this.variantData(v, index)) },
        modifierGroups: { create: input.modifierGroupIds.map((modifierGroupId, sortOrder) => ({ modifierGroupId, sortOrder })) },
      },
      include: productInclude,
    });
    const dto = this.toProductDto(product);
    await this.audit.record(auth, { action: 'product.created', entityType: 'product', entityId: product.id, after: dto });
    return dto;
  }

  async updateProduct(auth: AuthContext, id: string, input: ProductPatch): Promise<ProductDto> {
    const before = await this.findProduct(auth, id);
    await this.assertProductReferences(auth, input);
    if (input.shortCode && input.shortCode !== before.shortCode) await this.assertShortCodeFree(auth, input.shortCode);
    if (input.variants) {
      assertDistinctNames(input.variants, 'variant');
      const existingIds = new Set(before.variants.map((v) => v.id));
      if (input.variants.some((v) => v.id && !existingIds.has(v.id))) {
        throw invalid('UNKNOWN_VARIANT', 'A variant in this list no longer exists. Refresh and try again.');
      }
    }

    const variants = input.variants;
    const basePricePaise = variants
      ? (variants[0]?.pricePaise ?? input.basePricePaise)
      : before.variants.length > 0 ? undefined : input.basePricePaise;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (variants) {
        const keptIds = variants.flatMap((v) => (v.id ? [v.id] : []));
        await tx.variant.updateMany({ where: { productId: id, deletedAt: null, id: { notIn: keptIds } }, data: { deletedAt: new Date() } });
        for (const [index, v] of variants.entries()) {
          if (v.id) await tx.variant.update({ where: { id: v.id }, data: this.variantData(v, index) });
          else await tx.variant.create({ data: { productId: id, ...this.variantData(v, index) } });
        }
      }
      if (input.modifierGroupIds) {
        await tx.productModifierGroup.deleteMany({ where: { productId: id } });
        await tx.productModifierGroup.createMany({
          data: input.modifierGroupIds.map((modifierGroupId, sortOrder) => ({ productId: id, modifierGroupId, sortOrder })),
        });
      }
      return tx.product.update({
        where: { id },
        data: {
          categoryId: input.categoryId,
          name: input.name,
          shortCode: input.shortCode,
          description: input.description,
          foodType: input.foodType,
          basePricePaise,
          taxGroupId: input.taxGroupId,
          priceIncludesTax: input.priceIncludesTax,
          hsnSac: input.hsnSac,
          stationId: input.stationId,
          sendToKitchen: input.sendToKitchen,
          isAvailable: input.isAvailable,
          isActive: input.isActive,
          isFavourite: input.isFavourite,
          imageUrl: input.imageKey,
        },
        include: productInclude,
      });
    });
    const dto = this.toProductDto(updated);
    await this.audit.record(auth, {
      action: 'product.updated', entityType: 'product', entityId: id, before: this.toProductDto(before), after: dto,
    });
    return dto;
  }

  /** The quick on/off switch used on the POS and kitchen display. */
  async setAvailability(auth: AuthContext, id: string, isAvailable: boolean): Promise<ProductDto> {
    const before = await this.findProduct(auth, id);
    const updated = await this.prisma.product.update({ where: { id }, data: { isAvailable }, include: productInclude });
    await this.audit.record(auth, {
      action: 'product.availability_changed', entityType: 'product', entityId: id,
      before: { isAvailable: before.isAvailable }, after: { isAvailable },
    });
    return this.toProductDto(updated);
  }

  /** Soft delete: past orders and invoices keep pointing at the product. The short code is freed for reuse. */
  async deleteProduct(auth: AuthContext, id: string): Promise<void> {
    const product = await this.findProduct(auth, id);
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date(), shortCode: null } });
    await this.audit.record(auth, { action: 'product.deleted', entityType: 'product', entityId: id, before: this.toProductDto(product) });
  }

  /**
   * Adds many products from spreadsheet rows. Each row is judged on its own: a row with a mistake, and a product that is
   * already on the menu, are skipped and reported, and the rest are added in one transaction. Categories that are named
   * but do not exist yet are created. A dry run reports the same verdicts and saves nothing.
   */
  async createProducts(auth: AuthContext, input: BulkInput): Promise<BulkProductsResult> {
    const restaurantId = auth.restaurantId;
    const [categories, taxGroups, existing] = await Promise.all([
      this.prisma.category.findMany({ where: { restaurantId, deletedAt: null }, select: { id: true, name: true, sortOrder: true } }),
      this.prisma.taxGroup.findMany({ where: { restaurantId }, select: { id: true, name: true } }),
      this.prisma.product.findMany({ where: { restaurantId, deletedAt: null }, select: { name: true, shortCode: true, categoryId: true, sortOrder: true } }),
    ]);
    const key = (text: string) => text.toLowerCase();
    const categoryByName = new Map(categories.map((c) => [key(c.name), c]));
    const taxGroupByName = new Map(taxGroups.map((t) => [key(t.name), t.id]));
    // A product is the same product when it has the same name in the same category.
    const taken = new Set(existing.map((p) => `${p.categoryId}/${key(p.name)}`));
    const codeOwner = new Map(existing.flatMap((p) => (p.shortCode ? [[p.shortCode, p.name] as const] : [])));
    const nextSortOrder = new Map<string, number>();
    for (const p of existing) nextSortOrder.set(p.categoryId, Math.max(nextSortOrder.get(p.categoryId) ?? 0, p.sortOrder + 1));

    // Categories to create, by lower-cased name, spelled as first written.
    const newCategories = new Map<string, { id: string; name: string }>();
    const products: Prisma.ProductCreateManyInput[] = [];
    const rows: BulkProductRowResult[] = input.rows.map((row, index) => {
      const skip = (status: 'duplicate' | 'error', message: string): BulkProductRowResult => ({ row: index, name: row.name, status, message });
      const read = readBulkRow(row);
      const taxGroupId = row.taxGroup ? taxGroupByName.get(key(row.taxGroup)) : null;
      if (taxGroupId === undefined) read.problems.push(`There is no tax group named "${row.taxGroup}"`);
      if (read.problems.length > 0) return skip('error', read.problems.join('. ') + '.');

      const category = categoryByName.get(key(row.category)) ?? newCategories.get(key(row.category)) ?? { id: randomUUID(), name: row.category };
      if (taken.has(`${category.id}/${key(row.name)}`)) return skip('duplicate', `"${row.name}" is already in ${category.name}.`);
      if (read.shortCode && codeOwner.has(read.shortCode)) {
        return skip('error', `Short code ${read.shortCode} is already used by "${codeOwner.get(read.shortCode)}".`);
      }

      if (!categoryByName.has(key(row.category))) newCategories.set(key(row.category), category);
      taken.add(`${category.id}/${key(row.name)}`);
      if (read.shortCode) codeOwner.set(read.shortCode, row.name);
      const sortOrder = nextSortOrder.get(category.id) ?? 0;
      nextSortOrder.set(category.id, sortOrder + 1);
      products.push({
        id: randomUUID(), restaurantId, categoryId: category.id, name: row.name, shortCode: read.shortCode, description: row.description || null,
        foodType: read.foodType, basePricePaise: read.pricePaise, taxGroupId: taxGroupId ?? null, hsnSac: read.hsnSac, sortOrder,
      });
      return { row: index, name: row.name, status: input.dryRun ? 'ready' : 'created', message: null };
    });

    const result: BulkProductsResult = {
      saved: false,
      created: products.length,
      duplicates: rows.filter((r) => r.status === 'duplicate').length,
      errors: rows.filter((r) => r.status === 'error').length,
      newCategories: [...newCategories.values()].map((c) => c.name),
      rows,
    };
    if (input.dryRun || products.length === 0) return result;

    const lastCategory = Math.max(-1, ...categories.map((c) => c.sortOrder));
    await this.prisma.$transaction(async (tx) => {
      await tx.category.createMany({
        data: [...newCategories.values()].map((c, index) => ({ id: c.id, restaurantId, name: c.name, sortOrder: lastCategory + 1 + index })),
      });
      await tx.product.createMany({ data: products });
      await this.audit.record(auth, {
        action: 'product.bulk_created', entityType: 'product',
        after: { count: products.length, products: products.map((p) => ({ id: p.id, name: p.name })), newCategories: result.newCategories },
      }, tx);
    });
    return { ...result, saved: true };
  }

  /** Soft-deletes many products at once, as deleteProduct does for one. Ids that are not on this restaurant's menu are ignored. */
  async deleteProducts(auth: AuthContext, ids: string[]): Promise<{ deleted: number }> {
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, restaurantId: auth.restaurantId, deletedAt: null }, select: { id: true, name: true, shortCode: true },
    });
    if (products.length === 0) return { deleted: 0 };
    await this.prisma.$transaction(async (tx) => {
      await tx.product.updateMany({ where: { id: { in: products.map((p) => p.id) } }, data: { deletedAt: new Date(), shortCode: null } });
      await this.audit.record(auth, {
        action: 'product.bulk_deleted', entityType: 'product', before: { count: products.length, products },
      }, tx);
    });
    return { deleted: products.length };
  }

  private variantData(variant: VariantInput, index: number) {
    return { name: variant.name, pricePaise: variant.pricePaise, isAvailable: variant.isAvailable, isDefault: index === 0, sortOrder: index };
  }

  private async findProduct(auth: AuthContext, id: string): Promise<ProductRow> {
    const product = await this.prisma.product.findFirst({
      where: { id, restaurantId: auth.restaurantId, deletedAt: null }, include: productInclude,
    });
    if (!product) throw notFound('Product');
    return product;
  }

  private async assertShortCodeFree(auth: AuthContext, shortCode: string): Promise<void> {
    const clash = await this.prisma.product.findFirst({ where: { restaurantId: auth.restaurantId, shortCode } });
    if (clash) throw conflict('SHORT_CODE_TAKEN', `Short code ${shortCode} is already used by "${clash.name}".`);
  }

  /** Every id in the input must belong to this restaurant. */
  private async assertProductReferences(auth: AuthContext, input: ProductPatch): Promise<void> {
    const restaurantId = auth.restaurantId;
    if (input.categoryId && !(await this.prisma.category.findFirst({ where: { id: input.categoryId, restaurantId, deletedAt: null } }))) {
      throw invalid('CATEGORY_NOT_FOUND', 'Choose a category.');
    }
    if (input.taxGroupId && !(await this.prisma.taxGroup.findFirst({ where: { id: input.taxGroupId, restaurantId } }))) {
      throw invalid('TAX_GROUP_NOT_FOUND', 'Choose a tax group.');
    }
    if (input.stationId && !(await this.prisma.kitchenStation.findFirst({ where: { id: input.stationId, restaurantId } }))) {
      throw invalid('STATION_NOT_FOUND', 'Choose a kitchen station.');
    }
    if (input.modifierGroupIds?.length) {
      const ids = [...new Set(input.modifierGroupIds)];
      if (ids.length !== input.modifierGroupIds.length) throw invalid('DUPLICATE_MODIFIER_GROUP', 'A modifier group is listed twice.');
      const found = await this.prisma.modifierGroup.count({ where: { id: { in: ids }, restaurantId, deletedAt: null } });
      if (found !== ids.length) throw invalid('MODIFIER_GROUP_NOT_FOUND', 'A selected modifier group no longer exists.');
    }
  }

  private toProductDto(p: ProductRow): ProductDto {
    return {
      id: p.id,
      categoryId: p.categoryId,
      categoryName: p.category.name,
      name: p.name,
      shortCode: p.shortCode,
      description: p.description,
      imageKey: p.imageUrl,
      imageUrl: this.storage.publicUrl(p.imageUrl),
      foodType: p.foodType,
      basePricePaise: p.basePricePaise,
      taxGroupId: p.taxGroupId,
      priceIncludesTax: p.priceIncludesTax,
      hsnSac: p.hsnSac,
      stationId: p.stationId,
      sendToKitchen: p.sendToKitchen,
      isAvailable: p.isAvailable,
      isActive: p.isActive,
      isFavourite: p.isFavourite,
      sortOrder: p.sortOrder,
      variants: p.variants.map((v) => ({
        id: v.id, name: v.name, pricePaise: v.pricePaise, isAvailable: v.isAvailable, isDefault: v.isDefault, sortOrder: v.sortOrder,
      })),
      modifierGroupIds: p.modifierGroups.map((link) => link.modifierGroupId),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}
