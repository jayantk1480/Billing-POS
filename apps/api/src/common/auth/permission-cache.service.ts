import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@pos/database';
import type { PermissionKey } from '@pos/types';
import { subscriptionOf } from '@pos/validation';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { REDIS } from '../../modules/redis/redis.module.js';

const ROLE_TTL_SECONDS = 300;
const roleKey = (roleId: string) => `auth:perm:${roleId}`;
const revokedKey = (sessionId: string) => `auth:revoked:${sessionId}`;
const ACCESS_TTL_SECONDS = 60;
const accessKey = (restaurantId: string) => `auth:access:${restaurantId}`;

/** What a restaurant may do right now: everything, look but not change (trial or paid period over), or nothing (suspended). */
export type RestaurantAccess = 'full' | 'read-only' | 'suspended';

/**
 * Answers, with one Redis round trip per request, the two questions an access token cannot:
 * has this session been revoked since the token was issued, and what may this role do right now.
 */
@Injectable()
export class PermissionCacheService {
  constructor(
    private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async load(sessionId: string, roleId: string, restaurantId?: string): Promise<{ revoked: boolean; permissions: Set<PermissionKey>; access: RestaurantAccess }> {
    const [revoked, cached, cachedAccess] = await this.redis.mget(revokedKey(sessionId), roleKey(roleId), accessKey(restaurantId ?? '-'));
    if (revoked) return { revoked: true, permissions: new Set(), access: 'suspended' };
    const access = !restaurantId ? 'full' : ((cachedAccess as RestaurantAccess | null) ?? (await this.restaurantAccess(restaurantId)));
    if (cached !== null && cached !== undefined) {
      return { revoked: false, permissions: new Set(JSON.parse(cached) as PermissionKey[]), access };
    }
    const keys = await this.rolePermissions(roleId);
    await this.redis.set(roleKey(roleId), JSON.stringify(keys), 'EX', ROLE_TTL_SECONDS);
    return { revoked: false, permissions: new Set(keys), access };
  }

  /** Read from the database and remembered for a minute, so a trial that runs out takes effect within that time. */
  private async restaurantAccess(restaurantId: string): Promise<RestaurantAccess> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { isActive: true, trialEndsAt: true, paidUntil: true } });
    const status = restaurant ? subscriptionOf(restaurant).status : 'SUSPENDED';
    const access: RestaurantAccess = status === 'SUSPENDED' ? 'suspended' : status === 'EXPIRED' ? 'read-only' : 'full';
    await this.redis.set(accessKey(restaurantId), access, 'EX', ACCESS_TTL_SECONDS);
    return access;
  }

  /** Call after a restaurant is suspended, reactivated, or its trial or paid period changes. */
  async invalidateRestaurant(restaurantId: string): Promise<void> {
    await this.redis.del(accessKey(restaurantId));
  }

  async rolePermissions(roleId: string): Promise<PermissionKey[]> {
    const rows = await this.prisma.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { key: true } } } });
    return rows.map((row) => row.permission.key as PermissionKey);
  }

  /** Call after a role's permissions change. */
  async invalidateRole(roleId: string): Promise<void> {
    await this.redis.del(roleKey(roleId));
  }

  /** Makes access tokens of these sessions unusable for the rest of their lifetime. */
  async markRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const id of sessionIds) pipeline.set(revokedKey(id), '1', 'EX', env.JWT_ACCESS_TTL_SECONDS + 5);
    await pipeline.exec();
  }
}
