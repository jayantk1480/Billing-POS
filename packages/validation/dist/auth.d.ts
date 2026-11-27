import type { PermissionKey } from '@pos/types';
import { z } from 'zod';
/**
 * Each front-end app keeps its own refresh cookie, so signing in to one does not sign out another.
 * `mobile` is the billing app installed on a phone or tablet. It has no browser to hold a cookie, so it
 * is handed its refresh token in the sign-in answer and sends it back in the `X-Refresh-Token` header.
 */
export declare const clientAppSchema: z.ZodEnum<{
    web: "web";
    pos: "pos";
    kds: "kds";
    mobile: "mobile";
}>;
export type ClientApp = z.infer<typeof clientAppSchema>;
/** Clients that carry their refresh token themselves instead of in a cookie. */
export declare const isNativeClient: (client: ClientApp) => boolean;
/** The header a native client sends its refresh token in. */
export declare const REFRESH_TOKEN_HEADER = "x-refresh-token";
export declare const loginSchema: z.ZodObject<{
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
    password: z.ZodString;
    client: z.ZodEnum<{
        web: "web";
        pos: "pos";
        kds: "kds";
        mobile: "mobile";
    }>;
    terminalId: z.ZodOptional<z.ZodUUID>;
}, z.core.$strip>;
export type LoginInput = z.infer<typeof loginSchema>;
export declare const clientOnlySchema: z.ZodObject<{
    client: z.ZodEnum<{
        web: "web";
        pos: "pos";
        kds: "kds";
        mobile: "mobile";
    }>;
}, z.core.$strip>;
export declare const selectTerminalSchema: z.ZodObject<{
    client: z.ZodEnum<{
        web: "web";
        pos: "pos";
        kds: "kds";
        mobile: "mobile";
    }>;
    terminalId: z.ZodUUID;
}, z.core.$strip>;
export declare const pinLoginSchema: z.ZodObject<{
    client: z.ZodEnum<{
        web: "web";
        pos: "pos";
        kds: "kds";
        mobile: "mobile";
    }>;
    userId: z.ZodUUID;
    pin: z.ZodString;
}, z.core.$strip>;
export type PinLoginInput = z.infer<typeof pinLoginSchema>;
export declare const forgotPasswordSchema: z.ZodObject<{
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
}, z.core.$strip>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export declare const resetPasswordSchema: z.ZodObject<{
    token: z.ZodString;
    password: z.ZodString;
}, z.core.$strip>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export declare const changePasswordSchema: z.ZodObject<{
    currentPassword: z.ZodString;
    newPassword: z.ZodString;
}, z.core.$strip>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export interface AuthUser {
    id: string;
    name: string;
    email: string;
    restaurantId: string;
    restaurantName: string;
    role: {
        id: string;
        key: string;
        name: string;
    };
    permissions: PermissionKey[];
    /** Reports shared with this user individually, on top of what their role allows. */
    sharedReports: string[];
    terminalId: string | null;
}
export interface AuthResponse {
    accessToken: string;
    /** Seconds until the access token expires. */
    expiresIn: number;
    user: AuthUser;
    /** Only for a native client (see `isNativeClient`): the token to keep in the device's secure storage. Browsers get a cookie instead. */
    refreshToken?: string;
}
export interface SessionInfo {
    id: string;
    client: string | null;
    userAgent: string | null;
    ip: string | null;
    terminalName: string | null;
    createdAt: string;
    expiresAt: string;
    current: boolean;
}
export interface PinUser {
    id: string;
    name: string;
    roleName: string;
}
//# sourceMappingURL=auth.d.ts.map