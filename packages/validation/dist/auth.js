import { z } from 'zod';
import { emailSchema, passwordSchema, pinSchema, uuidSchema } from './common.js';
/**
 * Each front-end app keeps its own refresh cookie, so signing in to one does not sign out another.
 * `mobile` is the billing app installed on a phone or tablet. It has no browser to hold a cookie, so it
 * is handed its refresh token in the sign-in answer and sends it back in the `X-Refresh-Token` header.
 */
export const clientAppSchema = z.enum(['web', 'pos', 'kds', 'mobile']);
/** Clients that carry their refresh token themselves instead of in a cookie. */
export const isNativeClient = (client) => client === 'mobile';
/** The header a native client sends its refresh token in. */
export const REFRESH_TOKEN_HEADER = 'x-refresh-token';
export const loginSchema = z.object({
    email: emailSchema,
    password: z.string().min(1, 'Enter your password').max(200),
    client: clientAppSchema,
    terminalId: uuidSchema.optional(),
});
export const clientOnlySchema = z.object({ client: clientAppSchema });
export const selectTerminalSchema = z.object({ client: clientAppSchema, terminalId: uuidSchema });
export const pinLoginSchema = z.object({ client: clientAppSchema, userId: uuidSchema, pin: pinSchema });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword: passwordSchema,
});
//# sourceMappingURL=auth.js.map