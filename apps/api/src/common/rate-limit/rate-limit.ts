import {
  type CanActivate, type ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { REDIS } from '../../modules/redis/redis.module.js';
import { TokenService } from '../auth/token.service.js';

export interface RateLimitRule {
  /** Bucket name; requests to routes sharing a name share the budget. */
  name: string;
  limit: number;
  windowSeconds: number;
}

const RATE_LIMIT = 'rate-limit:rules';
const DEFAULT_RULE: RateLimitRule = { name: 'api', limit: 600, windowSeconds: 60 };

/** Replaces the default per-IP limit for a route with stricter rules. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMIT, rules);

// Increment and set the expiry atomically, so a key can never be left without a TTL.
const CONSUME = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('TTL', KEYS[1]) }`;

@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Counts one attempt against `key`. Returns seconds to wait if the limit is exceeded, else 0. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<number> {
    const [count, ttl] = (await this.redis.eval(CONSUME, 1, `rl:${key}`, windowSeconds)) as [number, number];
    return count > limit ? Math.max(ttl, 1) : 0;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}

/**
 * Applied to every route: a fixed-window limit, held in Redis so it works across instances.
 *
 * Routes with rules of their own (signing in, PINs, sign-up) are limited per client IP. The general budget is per
 * signed-in session when the request carries a valid access token, and per client IP otherwise. Every device at an
 * outlet reaches the API from the same address, so a per-address budget would be shared by all its tills, kitchen
 * screens and back-office tabs, and a busy lunch would run out of it in the middle of billing.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const own = this.reflector.getAllAndOverride<RateLimitRule[]>(RATE_LIMIT, [context.getHandler(), context.getClass()]);
    const rules = own ?? [DEFAULT_RULE];
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const ip = request.ip ?? 'unknown';
    const client = own ? ip : await this.sessionOf(request, ip);

    for (const rule of rules) {
      const retryAfter = await this.limiter.consume(`${rule.name}:${client}`, rule.limit, rule.windowSeconds);
      if (retryAfter > 0) {
        http.getResponse<Response>().setHeader('Retry-After', retryAfter);
        throw new HttpException('Too many attempts. Please wait and try again.', HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    return true;
  }

  /** The session a valid access token belongs to; anything else (no token, a forged or expired one) counts by address. */
  private async sessionOf(request: Request, ip: string): Promise<string> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return ip;
    try {
      return `session:${(await this.tokens.verifyAccessToken(header.slice(7))).sessionId}`;
    } catch {
      return ip;
    }
  }
}
