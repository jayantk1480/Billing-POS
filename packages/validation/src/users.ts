import { PERMISSION_KEYS, type PermissionKey } from '@pos/types';
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
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: text(80, 'Name').optional(),
  phone: nullableText(20),
  roleId: uuidSchema.optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
  /** null removes the PIN. */
  pin: pinSchema.nullish(),
});
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export interface UserDto {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  hasPin: boolean;
  role: { id: string; key: string; name: string };
  lastLoginAt: string | null;
  createdAt: string;
}

const permissionKeySchema = z.enum(PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]]);

export const createRoleSchema = z.object({
  name: text(40, 'Role name'),
  permissions: z.array(permissionKeySchema).max(PERMISSION_KEYS.length),
});
export type CreateRoleInput = z.input<typeof createRoleSchema>;

export const updateRoleSchema = createRoleSchema.partial();
export type UpdateRoleInput = z.input<typeof updateRoleSchema>;

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: PermissionKey[];
  userCount: number;
}

export interface PermissionDto {
  key: PermissionKey;
  group: string;
  description: string;
}
