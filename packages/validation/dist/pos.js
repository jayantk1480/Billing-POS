import { z } from 'zod';
import { nullableText, uuidSchema } from './common.js';
/**
 * A device signing up for billing offline. It chooses its own key once and keeps it; registering again with the same
 * key returns the same device. The device's bills while the internet is down are numbered in its own series.
 */
export const registerDeviceSchema = z.object({
    deviceKey: uuidSchema,
    /** What the device is, as people would recognise it: "Counter tablet", or the browser's description. */
    label: nullableText(200),
});
//# sourceMappingURL=pos.js.map