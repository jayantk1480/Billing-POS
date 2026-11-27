import { applyDecorators, createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@pos/types';
import type { Request } from 'express';

/** Who is making the request. Set by AuthGuard; every query is scoped by `restaurantId`. */
export interface AuthContext {
  userId: string;
  restaurantId: string;
  roleId: string;
  /** Session family id: stays the same across refresh-token rotations. */
  sessionId: string;
  terminalId: string | null;
  permissions: ReadonlySet<PermissionKey>;
  ip: string | null;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_PERMISSIONS = 'auth:permissions';

/** Marks a route that needs no access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The caller's role must hold every listed permission. */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const REQUIRED_ANY_PERMISSION = 'auth:any-permission';
/**
 * Allows a route for anyone holding at least one of the permissions, in place of whatever the controller requires.
 * For reading: someone who may only look at order history should be able to open it without the right to take orders.
 */
export const RequireAnyPermission = (...permissions: PermissionKey[]) =>
  applyDecorators(SetMetadata(REQUIRED_PERMISSIONS, []), SetMetadata(REQUIRED_ANY_PERMISSION, permissions));

export const ALLOW_WHEN_EXPIRED = 'auth:allow-when-expired';
/**
 * A restaurant whose trial or paid period is over can look at everything but change nothing. This marks the few
 * changes that stay allowed: signing out, locking a terminal, changing a password.
 */
export const AllowWhenExpired = () => SetMetadata(ALLOW_WHEN_EXPIRED, true);

/** Injects the AuthContext of the signed-in caller. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new Error('CurrentAuth used on a route without authentication');
  return auth;
});
