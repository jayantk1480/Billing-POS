import { z } from 'zod';
export declare const foodTypeSchema: z.ZodEnum<{
    VEG: "VEG";
    NON_VEG: "NON_VEG";
    EGG: "EGG";
}>;
export type FoodType = z.infer<typeof foodTypeSchema>;
export declare const categorySchema: z.ZodObject<{
    name: z.ZodString;
    color: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type CategoryInput = z.input<typeof categorySchema>;
export declare const updateCategorySchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    isActive: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, z.core.$strip>;
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;
export declare const reorderSchema: z.ZodObject<{
    ids: z.ZodArray<z.ZodUUID>;
}, z.core.$strip>;
export interface CategoryDto {
    id: string;
    name: string;
    color: string | null;
    sortOrder: number;
    isActive: boolean;
    productCount: number;
}
export declare const modifierSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodUUID>;
    name: z.ZodString;
    pricePaise: z.ZodNumber;
    isAvailable: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const modifierGroupSchema: z.ZodObject<{
    name: z.ZodString;
    minSelect: z.ZodNumber;
    maxSelect: z.ZodNumber;
    isActive: z.ZodDefault<z.ZodBoolean>;
    modifiers: z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodUUID>;
        name: z.ZodString;
        pricePaise: z.ZodNumber;
        isAvailable: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
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
export declare const variantSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodUUID>;
    name: z.ZodString;
    pricePaise: z.ZodNumber;
    isAvailable: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const imageKeySchema: z.ZodString;
export declare const createProductSchema: z.ZodObject<{
    categoryId: z.ZodUUID;
    name: z.ZodString;
    shortCode: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
    description: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    foodType: z.ZodDefault<z.ZodEnum<{
        VEG: "VEG";
        NON_VEG: "NON_VEG";
        EGG: "EGG";
    }>>;
    basePricePaise: z.ZodNumber;
    taxGroupId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
    priceIncludesTax: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    hsnSac: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
    stationId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
    sendToKitchen: z.ZodDefault<z.ZodBoolean>;
    isAvailable: z.ZodDefault<z.ZodBoolean>;
    isActive: z.ZodDefault<z.ZodBoolean>;
    isFavourite: z.ZodDefault<z.ZodBoolean>;
    imageKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    variants: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodUUID>;
        name: z.ZodString;
        pricePaise: z.ZodNumber;
        isAvailable: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    modifierGroupIds: z.ZodDefault<z.ZodArray<z.ZodUUID>>;
}, z.core.$strip>;
export type CreateProductInput = z.input<typeof createProductSchema>;
export declare const updateProductSchema: z.ZodObject<{
    foodType: z.ZodOptional<z.ZodEnum<{
        VEG: "VEG";
        NON_VEG: "NON_VEG";
        EGG: "EGG";
    }>>;
    isAvailable: z.ZodOptional<z.ZodBoolean>;
    isActive: z.ZodOptional<z.ZodBoolean>;
    isFavourite: z.ZodOptional<z.ZodBoolean>;
    sendToKitchen: z.ZodOptional<z.ZodBoolean>;
    variants: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodUUID>;
        name: z.ZodString;
        pricePaise: z.ZodNumber;
        isAvailable: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    modifierGroupIds: z.ZodOptional<z.ZodArray<z.ZodUUID>>;
    categoryId: z.ZodOptional<z.ZodUUID>;
    name: z.ZodOptional<z.ZodString>;
    shortCode: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
    description: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    basePricePaise: z.ZodOptional<z.ZodNumber>;
    taxGroupId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodUUID>>>;
    priceIncludesTax: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>;
    hsnSac: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
    stationId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodUUID>>>;
    imageKey: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
}, z.core.$strip>;
export type UpdateProductInput = z.input<typeof updateProductSchema>;
export declare const availabilitySchema: z.ZodObject<{
    isAvailable: z.ZodBoolean;
}, z.core.$strip>;
/** One row of an import. Category and tax group are given by name; the price is in rupees, as text. */
export declare const bulkProductRowSchema: z.ZodObject<{
    name: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    category: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    price: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    shortCode: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    foodType: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    taxGroup: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    description: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    hsnSac: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
}, z.core.$strip>;
export type BulkProductRow = z.input<typeof bulkProductRowSchema>;
export declare const BULK_PRODUCT_LIMIT = 500;
export declare const bulkProductsSchema: z.ZodObject<{
    rows: z.ZodArray<z.ZodObject<{
        name: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        category: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        price: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        shortCode: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        foodType: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        taxGroup: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        description: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
        hsnSac: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string, string | null | undefined>>;
    }, z.core.$strip>>;
    dryRun: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
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
export declare const bulkDeleteProductsSchema: z.ZodObject<{
    ids: z.ZodArray<z.ZodUUID>;
}, z.core.$strip>;
export type BulkDeleteProductsInput = z.input<typeof bulkDeleteProductsSchema>;
export declare const productQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    search: z.ZodOptional<z.ZodString>;
    categoryId: z.ZodOptional<z.ZodUUID>;
    availability: z.ZodOptional<z.ZodEnum<{
        available: "available";
        unavailable: "unavailable";
    }>>;
    sort: z.ZodOptional<z.ZodEnum<{
        category: "category";
        price: "price";
        available: "available";
        product: "product";
        tax: "tax";
    }>>;
    direction: z.ZodDefault<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>;
}, z.core.$strip>;
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
//# sourceMappingURL=menu.d.ts.map