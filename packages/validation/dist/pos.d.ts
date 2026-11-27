import { z } from 'zod';
import type { CategoryDto, ModifierGroupDto, ProductDto } from './menu.js';
import type { PrintLayoutsDto } from './printing.js';
import type { TableDto } from './orders.js';
import type { RestaurantDto, SettingsDto, TaxGroupDto, TerminalDto } from './restaurant.js';
import type { DeviceNumbersDto } from './sync.js';
/** Everything the POS needs to take orders, fetched in one request (and cached for offline use later). */
export interface PosBootstrap {
    restaurant: RestaurantDto;
    settings: SettingsDto;
    terminal: TerminalDto | null;
    categories: CategoryDto[];
    products: ProductDto[];
    modifierGroups: ModifierGroupDto[];
    taxGroups: TaxGroupDto[];
    tables: TableDto[];
    /** Today's business date for this restaurant, "YYYY-MM-DD". */
    businessDate: string;
    /** How bills and kitchen tickets are laid out, so the POS can print them without asking the server. */
    printLayouts: PrintLayoutsDto;
    /**
     * The kitchen stations that take tickets, in kitchen order: an item with no station of its own, or whose station is
     * switched off, goes to the first. For sending orders to the kitchen while offline.
     */
    stations: {
        id: string;
        name: string;
    }[];
}
/**
 * A device signing up for billing offline. It chooses its own key once and keeps it; registering again with the same
 * key returns the same device. The device's bills while the internet is down are numbered in its own series.
 */
export declare const registerDeviceSchema: z.ZodObject<{
    deviceKey: z.ZodUUID;
    label: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type RegisterDeviceInput = z.input<typeof registerDeviceSchema>;
export interface PosDeviceDto {
    id: string;
    /** The code of the device's own offline series, such as "Z01": its offline bills read Z01/2627/000001. */
    offlineCode: string;
    registeredAt: string;
    /** Where the device's own series stand on the server, to carry on from. */
    numbers: DeviceNumbersDto;
}
//# sourceMappingURL=pos.d.ts.map