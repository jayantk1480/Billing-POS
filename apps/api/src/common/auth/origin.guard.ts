import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { clientAppSchema, isNativeClient } from '@pos/validation';
import type { Request } from 'express';
import { env } from '../../config/env.js';

/**
 * For routes authenticated by the refresh cookie: the request must come from one of our own
 * front ends. Together with SameSite=Strict this blocks cross-site request forgery.
 *
 * A native app (client "mobile") is let through: it has no origin to send, and the routes never read
 * a cookie for it. Its refresh token comes in a header that no other site can fill in, so there is
 * nothing for a forged request to ride on.
 */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const named = clientAppSchema.safeParse((request.body as { client?: unknown } | undefined)?.client ?? request.query.client);
    if (named.success && isNativeClient(named.data)) return true;

    const origin = request.headers.origin;
    if (!origin || !env.CORS_ORIGINS.includes(origin)) {
      throw new ForbiddenException('This request is not allowed from this origin.');
    }
    return true;
  }
}
