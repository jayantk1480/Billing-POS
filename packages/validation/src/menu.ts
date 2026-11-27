import { z } from 'zod';
import { nullableText, pageQuerySchema, paiseSchema, sortDirectionSchema, text, uuidSchema } from './common.js';

export const foodTypeSchema = z.enum(['VEG', 'NON_VEG', 'EGG']);
export type FoodType = z.infer<typeof foodTypeSchema>;

// ── Categories ──

export const categorySchema = z.object({
  name: text(60, 'Name'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a colour').nullish(),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.input<typeof categorySchema>;
export const updateCategorySchema = categorySchema.partial();
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;

export const reorderSchema = z.object({ ids: z.array(uuidSchema).min(1).max(500) });

export interface CategoryDto {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
}

// ── Modifier groups ──

export const modifierSchema = z.object({
  /** Present for an existing option; absent for a new one. */
  id: uuidSchema.optional(),
  name: text(60, 'Option name'),
  pricePaise: paiseSchema,
  isAvailable: z.boolean().default(true),
});

export const modifierGroupSchema = z
  .object({
    name: text(60, 'Name'),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    isActive: z.boolean().default(true),
    /** The full list of options: options missing from the list are removed. */
    modifiers: z.array(modifierSchema).min(1, 'Add at least one option').max(50),
  })
  .refine((group) => group.maxSelect >= group.minSelect, {
    path: ['maxSelect'],
    message: 'Maximum must be at least the minimum',
  })
  .refine((group) => group.modifiers.length >= group.minSelect, {
    path: ['minSelect'],
    message: 'Minimum cannot exceed the number of options',
  });
export type ModifierGroupInput = z.input<typeof modifierGroupSchema>;

export interface ModifierDto {
  id: string;
  name: string;
  pricePaise: number;
  isAvailable: boolean;
  sortOrder: number;
}

export interface ModifierGroupDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  modifiers: ModifierDto[];
  productCount: number;
}

// ── Products ──

export const variantSchema = z.object({
  id: uuidSchema.optional(),
  name: text(40, 'Variant name'),
  pricePaise: paiseSchema,
  isAvailable: z.boolean().default(true),
});

export const imageKeySchema = z.string().regex(/^images\/[0-9a-f-]{36}\.(png|jpg|webp)$/, 'Invalid image');

const productFields = {
  categoryId: uuidSchema,
  name: text(120, 'Name'),
  shortCode: z
    .union([z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use up to 8 letters or digits'), z.literal('').transform(() => null), z.null()])
    .optional(),
  description: nullableText(500),
  foodType: foodTypeSchema.default('VEG'),
  basePricePaise: paiseSchema,
  /** null uses the restaurant's default tax group. */
  taxGroupId: uuidSchema.nullish(),
  /** null follows the restaurant-wide "prices include tax" setting. */
  priceIncludesTax: z.boolean().nullish(),
  hsnSac: z
    .union([z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC has 4 to 8 digits'), z.literal('').transform(() => null), z.null()])
    .optional(),
  /** null sends the item to the first active kitchen station. */
  stationId: uuidSchema.nullish(),
  /** False for something the kitchen never makes, such as bottled water: it is never on a kitchen ticket. */
  sendToKitchen: z.boolean().default(true),
  isAvailable: z.boolean().default(true),
  isActive: z.boolean().default(true),
  isFavourite: z.boolean().default(false),
  imageKey: imageKeySchema.nullish(),
  /** The full list of variants: variants missing from the list are removed. The first is the default. */
  variants: z.array(variantSchema).max(20).default([]),
  modifierGroupIds: z.array(uuidSchema).max(20).default([]),
};

export const createProductSchema = z.object(productFields);
export type CreateProductInput = z.input<typeof createProductSchema>;

export const updateProductSchema = z.object({
  ...productFields,
  foodType: foodTypeSchema,
  isAvailable: z.boolean(),
  isActive: z.boolean(),
  isFavourite: z.boolean(),
  sendToKitchen: z.boolean(),
  variants: z.array(variantSchema).max(20),
  modifierGroupIds: z.array(uuidSchema).max(20),
}).partial();
export type UpdateProductInput = z.input<typeof updateProductSchema>;

export const availabilitySchema = z.object({ isAvailable: z.boolean() });

// ── Adding and deleting many products at once ──

/** A cell as typed in a spreadsheet. Its meaning is judged later, row by row, so one bad row does not refuse the whole file. */
const cell = z.string().max(600).nullish().transform((value) => (value ?? '').trim());

/** One row of an import. Category and tax group are given by name; the price is in rupees, as text. */
export const bulkProductRowSchema = z.object({
  name: cell,
  category: cell,
  price: cell,
  shortCode: cell,
  /** "veg", "non-veg" or "egg"; blank means veg. */
  foodType: cell,
  /** Blank uses the restaurant's default tax group. */
  taxGroup: cell,
  description: cell,
  hsnSac: cell,
});
export type BulkProductRow = z.input<typeof bulkProductRowSchema>;

export const BULK_PRODUCT_LIMIT = 500;

export const bulkProductsSchema = z.object({
  rows: z.array(bulkProductRowSchema).min(1, 'Add at least one row').max(BULK_PRODUCT_LIMIT, `Add at most ${BULK_PRODUCT_LIMIT} products at a time`),
  /** true reports what would happen to each row and saves nothing. */
  dryRun: z.boolean().default(false),
});
export type BulkProductsInput = z.input<typeof bulkProductsSchema>;

export interface BulkProductRowResult {
  /** Position of the row in the request, from 0. */
  row: number;
  name: string;
  /** "ready" on a dry run and "created" on a real one; a duplicate is already on the menu and is skipped. */
  status: 'ready' | 'created' | 'duplicate' | 'error';
  /** Why the row is skipped; null for a row that is added. */
  message: string | null;
}

export interface BulkProductsResult {
  /** false on a dry run. */
  saved: boolean;
  /** Rows added, or that would be added on a dry run. */
  created: number;
  duplicates: number;
  errors: number;
  /** Categories named in the rows that do not exist yet; they are created along with the products. */
  newCategories: string[];
  rows: BulkProductRowResult[];
}

export const bulkDeleteProductsSchema = z.object({
  ids: z.array(uuidSchema).min(1, 'Choose at least one product').max(BULK_PRODUCT_LIMIT, `Delete at most ${BULK_PRODUCT_LIMIT} products at a time`),
});
export type BulkDeleteProductsInput = z.input<typeof bulkDeleteProductsSchema>;

export const productQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(80).optional(),
  categoryId: uuidSchema.optional(),
  availability: z.enum(['available', 'unavailable']).optional(),
  /** The column to sort by. Left out, products follow the menu's own order. */
  sort: z.enum(['product', 'category', 'price', 'tax', 'available']).optional(),
  direction: sortDirectionSchema,
});
export type ProductQuery = z.input<typeof productQuerySchema>;

export interface VariantDto {
  id: string;
  name: string;
  pricePaise: number;
  isAvailable: boolean;
  isDefault: boolean;
  sortOrder: number;
}

export interface ProductDto {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  shortCode: string | null;
  description: string | null;
  imageKey: string | null;
  imageUrl: string | null;
  foodType: FoodType;
  basePricePaise: number;
  taxGroupId: string | null;
  priceIncludesTax: boolean | null;
  hsnSac: string | null;
  stationId: string | null;
  sendToKitchen: boolean;
  isAvailable: boolean;
  isActive: boolean;
  isFavourite: boolean;
  sortOrder: number;
  variants: VariantDto[];
  modifierGroupIds: string[];
  updatedAt: string;
}

export interface UploadedImage {
  key: string;
  url: string;
}
