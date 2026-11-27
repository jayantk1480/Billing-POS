import type { PermissionKey } from '@pos/types';
import { z } from 'zod';
import { emailSchema, passwordSchema, pinSchema, uuidSchema } from './common.js';

/**
 * Each front-end app keeps its own refresh cookie, so signing in to one does not sign out another.
 * `mobile` is the billing app installed on a phone or tablet. It has no browser to hold a cookie, so it
 * is handed its refresh token in the sign-in answer and sends it back in the `X-Refresh-Token` header.
 */
export const clientAppSchema = z.enum(['web', 'pos', 'kds', 'mobile']);
export type ClientApp = z.infer<typeof clientAppSchema>;

/** Clients that carry their refresh token themselves instead of in a cookie. */
export const isNativeClient = (client: ClientApp): boolean => client === 'mobile';
/** The header a native client sends its refresh token in. */
export const REFRESH_TOKEN_HEADER = 'x-refresh-token';

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(200),
  client: clientAppSchema,
  terminalId: uuidSchema.optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const clientOnlySchema = z.object({ client: clientAppSchema });

export const selectTerminalSchema = z.object({ client: clientAppSchema, terminalId: uuidSchema });

export const pinLoginSchema = z.object({ client: clientAppSchema, userId: uuidSchema, pin: pinSchema });
export type PinLoginInput = z.infer<typeof pinLoginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(200),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  restaurantId: string;
  restaurantName: string;
  role: { id: string; key: string; name: string };
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
