import { type PermissionKey } from '@pos/types';
import { z } from 'zod';
export declare const createUserSchema: z.ZodObject<{
    name: z.ZodString;
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
    phone: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    roleId: z.ZodUUID;
    password: z.ZodString;
    pin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type CreateUserInput = z.input<typeof createUserSchema>;
export declare const updateUserSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    phone: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    roleId: z.ZodOptional<z.ZodUUID>;
    isActive: z.ZodOptional<z.ZodBoolean>;
    password: z.ZodOptional<z.ZodString>;
    pin: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export type UpdateUserInput = z.input<typeof updateUserSchema>;
export interface UserDto {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    isActive: boolean;
    hasPin: boolean;
    role: {
        id: string;
        key: string;
        name: string;
    };
    lastLoginAt: string | null;
    createdAt: string;
}
export declare const createRoleSchema: z.ZodObject<{
    name: z.ZodString;
    permissions: z.ZodArray<z.ZodEnum<{
        "backoffice.access": "backoffice.access";
        "dashboard.view": "dashboard.view";
        "settings.manage": "settings.manage";
        "users.manage": "users.manage";
        "menu.view": "menu.view";
        "menu.manage": "menu.manage";
        "menu.availability": "menu.availability";
        "tables.manage": "tables.manage";
        "order.create": "order.create";
        "order.view_all": "order.view_all";
        "order.cancel": "order.cancel";
        "order.delete": "order.delete";
        "order.renumber": "order.renumber";
        "order.transfer": "order.transfer";
        "discount.apply": "discount.apply";
        "discount.above_cap": "discount.above_cap";
        "kot.fire": "kot.fire";
        "kot.cancel_item": "kot.cancel_item";
        "kot.update_status": "kot.update_status";
        "invoice.create": "invoice.create";
        "invoice.reprint": "invoice.reprint";
        "invoice.cancel_after_settlement": "invoice.cancel_after_settlement";
        "invoice.delete": "invoice.delete";
        "payment.record": "payment.record";
        "payment.reconcile": "payment.reconcile";
        "payment.change_method": "payment.change_method";
        "refund.create": "refund.create";
        "register.operate": "register.operate";
        "register.adjust": "register.adjust";
        "register.view_all": "register.view_all";
        "report.view": "report.view";
        "report.share": "report.share";
        "audit.view": "audit.view";
    }>>;
}, z.core.$strip>;
export type CreateRoleInput = z.input<typeof createRoleSchema>;
export declare const updateRoleSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    permissions: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        "backoffice.access": "backoffice.access";
        "dashboard.view": "dashboard.view";
        "settings.manage": "settings.manage";
        "users.manage": "users.manage";
        "menu.view": "menu.view";
        "menu.manage": "menu.manage";
        "menu.availability": "menu.availability";
        "tables.manage": "tables.manage";
        "order.create": "order.create";
        "order.view_all": "order.view_all";
        "order.cancel": "order.cancel";
        "order.delete": "order.delete";
        "order.renumber": "order.renumber";
        "order.transfer": "order.transfer";
        "discount.apply": "discount.apply";
        "discount.above_cap": "discount.above_cap";
        "kot.fire": "kot.fire";
        "kot.cancel_item": "kot.cancel_item";
        "kot.update_status": "kot.update_status";
        "invoice.create": "invoice.create";
        "invoice.reprint": "invoice.reprint";
        "invoice.cancel_after_settlement": "invoice.cancel_after_settlement";
        "invoice.delete": "invoice.delete";
        "payment.record": "payment.record";
        "payment.reconcile": "payment.reconcile";
        "payment.change_method": "payment.change_method";
        "refund.create": "refund.create";
        "register.operate": "register.operate";
        "register.adjust": "register.adjust";
        "register.view_all": "register.view_all";
        "report.view": "report.view";
        "report.share": "report.share";
        "audit.view": "audit.view";
    }>>>;
}, z.core.$strip>;
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
//# sourceMappingURL=users.d.ts.map