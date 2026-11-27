import { type CanActivate, type ExecutionContext, ForbiddenException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@pos/types';
import { DomainError } from '../filters/api-exception.filter.js';
import { ALLOW_WHEN_EXPIRED, type AuthedRequest, IS_PUBLIC, REQUIRED_PERMISSIONS, REQUIRED_ANY_PERMISSION } from './auth-context.js';
import { PermissionCacheService } from './permission-cache.service.js';
import { TokenService } from './token.service.js';

/** Applied to every route: requires a valid access token unless the route is `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly permissionCache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sign in to continue.');

    const claims = await this.tokens.verifyAccessToken(header.slice(7));
    const { revoked, permissions, access } = await this.permissionCache.load(claims.sessionId, claims.roleId, claims.restaurantId);
    if (revoked) throw new UnauthorizedException('Your session has ended. Sign in again.');
    if (access === 'suspended') {
      throw new DomainError('RESTAURANT_SUSPENDED', 'This restaurant\'s account has been suspended. Contact support to restore it.', HttpStatus.FORBIDDEN);
    }
    // Reading stays open, so the restaurant always has its own bills and reports.
    if (access === 'read-only' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_EXPIRED, targets)) {
      throw new DomainError(
        'SUBSCRIPTION_EXPIRED',
        'Your trial or paid period has ended, so nothing can be changed. You can still view and export everything. Contact us to continue.',
        HttpStatus.FORBIDDEN,
      );
    }

    req.auth = { ...claims, permissions, ip: req.ip ?? null };

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const anyOf = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_ANY_PERMISSION, targets) ?? [];
    if (required.some((permission) => !permissions.has(permission)) || (anyOf.length > 0 && !anyOf.some((permission) => permissions.has(permission)))) {
      throw new ForbiddenException('You do not have permission to do this.');
    }
    return true;
  }
}
