import { PERMISSION_KEYS } from '@pos/types';
import { z } from 'zod';
import { emailSchema, nullableText, passwordSchema, pinSchema, text, uuidSchema } from './common.js';
export const createUserSchema = z.object({
    name: text(80, 'Name'),
    email: emailSchema,
    phone: nullableText(20),
    roleId: uuidSchema,
    password: passwordSchema,
    pin: pinSchema.nullish(),
});
export const updateUserSchema = z.object({
    name: text(80, 'Name').optional(),
    phone: nullableText(20),
    roleId: uuidSchema.optional(),
    isActive: z.boolean().optional(),
    password: passwordSchema.optional(),
    /** null removes the PIN. */
    pin: pinSchema.nullish(),
});
const permissionKeySchema = z.enum(PERMISSION_KEYS);
export const createRoleSchema = z.object({
    name: text(40, 'Role name'),
    permissions: z.array(permissionKeySchema).max(PERMISSION_KEYS.length),
});
export const updateRoleSchema = createRoleSchema.partial();
//# sourceMappingURL=users.js.map