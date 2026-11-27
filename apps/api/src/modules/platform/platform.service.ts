import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { type Prisma, PrismaClient, provisionRestaurant } from '@pos/database';
import { GST_STATES } from '@pos/types';
import {
  type Page, type platformCreateRestaurantSchema, type PlatformOverviewDto, type PlatformRestaurantDetailDto, type PlatformRestaurantDto,
  type platformRestaurantQuerySchema, type setPaidUntilSchema, type setTrialSchema, type SubscriptionStatus, subscriptionOf,
} from '@pos/validation';
import { Redis } from 'ioredis';
import type { z } from 'zod';
import { PasswordService } from '../../common/auth/password.service.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { TokenService } from '../../common/auth/token.service.js';
import { conflict, notFound } from '../../common/errors.js';
import { DomainError } from '../../common/filters/api-exception.filter.js';
import { env } from '../../config/env.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { REDIS } from '../redis/redis.module.js';
import type { PlatformActor } from './platform-auth.js';

const DAY_MS = 86_400_000;
const INVITE_LINK_DAYS = 7;
const STATUS_ORDER: SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED'];
type RestaurantRow = Prisma.RestaurantGetPayload<object>;

/** Who did it, as written into the restaurant's own audit log. */
const by = (admin: PlatformActor) => ({ platformAdmin: admin.name + ' <' + admin.email + '>' });
/** The end of a calendar day in India, which is when a trial "ending on" that day stops. */
const endOfDay = (isoDate: string) => new Date(isoDate + 'T23:59:59.999+05:30');

/**
 * What the vendor's own people can do across restaurants: see them, create them, suspend and restore them, and
 * set how long each may be used. They see how much a restaurant is used and what was done in it, never its bills.
 * Everything they change is written to that restaurant's audit log.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger('Platform');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly permissionCache: PermissionCacheService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ── Reading ──

  async overview(): Promise<PlatformOverviewDto> {
    const restaurants = await this.prisma.restaurant.findMany({ select: { id: true, name: true, isActive: true, trialEndsAt: true, paidUntil: true, createdAt: true } });
    const counts = { total: restaurants.length, ACTIVE: 0, TRIAL: 0, EXPIRED: 0, SUSPENDED: 0 };
    const ending: PlatformOverviewDto['trialsEndingSoon'] = [];
    for (const restaurant of restaurants) {
      const subscription = subscriptionOf(restaurant);
      counts[subscription.status] += 1;
      if (subscription.status === 'TRIAL' && subscription.trialEndsAt && (subscription.daysLeft ?? 99) < 7) {
        ending.push({ id: restaurant.id, name: restaurant.name, trialEndsAt: subscription.trialEndsAt, daysLeft: subscription.daysLeft ?? 0 });
      }
    }
    return {
      restaurants: counts,
      signupsLast30Days: restaurants.filter((restaurant) => restaurant.createdAt.getTime() > Date.now() - 30 * DAY_MS).length,
      trialsEndingSoon: ending.sort((a, b) => a.trialEndsAt.localeCompare(b.trialEndsAt)).slice(0, 20),
    };
  }

  async list(query: z.output<typeof platformRestaurantQuerySchema>): Promise<Page<PlatformRestaurantDto>> {
    const search = query.search?.toLowerCase();
    const all = (await this.summaries(await this.prisma.restaurant.findMany())).filter((row) =>
      (!query.status || row.subscription.status === query.status) &&
      (!search || [row.name, row.ownerName, row.ownerEmail, row.city].some((value) => value?.toLowerCase().includes(search))),
    );
    // The date a restaurant's time runs out, whichever kind it is on; restaurants with no limit sort last.
    const ends = (row: PlatformRestaurantDto) => (row.subscription.status === 'TRIAL' ? row.subscription.trialEndsAt : row.subscription.paidUntil) ?? '';
    const value: Record<typeof query.sort, (row: PlatformRestaurantDto) => string | number> = {
      name: (row) => row.name.toLowerCase(), created: (row) => row.createdAt, status: (row) => STATUS_ORDER.indexOf(row.subscription.status), ends,
      lastActive: (row) => row.lastActiveAt ?? '', bills: (row) => row.billsLast30Days, sales: (row) => row.salesLast30DaysPaise, users: (row) => row.users,
    };
    const pick = value[query.sort];
    const sign = query.direction === 'asc' ? 1 : -1;
    all.sort((a, b) => {
      const [left, right] = [pick(a), pick(b)];
      // Empty values go last whichever way the column is sorted.
      if ((left === '') !== (right === '')) return left === '' ? 1 : -1;
      return sign * (left < right ? -1 : left > right ? 1 : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
    const start = (query.page - 1) * query.pageSize;
    return { items: all.slice(start, start + query.pageSize), total: all.length, page: query.page, pageSize: query.pageSize };
  }

  /** One restaurant, for support. Opening it is recorded in the restaurant's audit log, at most once an hour per admin. */
  async detail(admin: PlatformActor, id: string): Promise<PlatformRestaurantDetailDto> {
    const restaurant = await this.find(id);
    const [[summary], settings, terminals, products, billsTotal, people, activity] = await Promise.all([
      this.summaries([restaurant]),
      this.prisma.restaurantSettings.findUnique({ where: { restaurantId: id } }),
      this.prisma.terminal.count({ where: { restaurantId: id, isActive: true, kind: 'COUNTER' } }),
      this.prisma.product.count({ where: { restaurantId: id, deletedAt: null } }),
      this.prisma.invoice.count({ where: { restaurantId: id } }),
      this.prisma.user.findMany({ where: { restaurantId: id }, include: { role: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.auditLog.findMany({ where: { restaurantId: id }, orderBy: { createdAt: 'desc' }, take: 40 }),
    ]);
    const names = new Map(people.map((person) => [person.id, person.name]));
    if ((await this.redis.set(`platform:viewed:${admin.id}:${id}`, '1', 'EX', 3600, 'NX')) === 'OK') {
      await this.audit.record({ restaurantId: id }, { action: 'platform.support_viewed', entityType: 'restaurant', entityId: id, after: by(admin) });
    }
    return {
      ...summary!, legalName: restaurant.legalName, gstin: restaurant.gstin, phone: restaurant.phone, gstRegistration: settings?.gstRegistration ?? 'REGULAR',
      terminals, products, billsTotal,
      people: people.map((person) => ({
        id: person.id, name: person.name, email: person.email, roleName: person.role.name, isActive: person.isActive, lastLoginAt: person.lastLoginAt?.toISOString() ?? null,
      })),
      activity: activity.map((entry) => ({
        at: entry.createdAt.toISOString(), action: entry.action, reason: entry.reason,
        // What the platform did carries the name of the admin who did it.
        userName: entry.userId ? (names.get(entry.userId) ?? null) : ((entry.after as { platformAdmin?: string } | null)?.platformAdmin ?? null),
      })),
    };
  }

  // ── Changing ──

  /** Sets a restaurant up for someone, who is emailed a link to choose their password. */
  async create(admin: PlatformActor, input: z.output<typeof platformCreateRestaurantSchema>): Promise<PlatformRestaurantDetailDto> {
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) {
      throw conflict('EMAIL_TAKEN', 'That email address already has an account. Each person signs in to one restaurant.');
    }
    // Nobody knows this password: the owner chooses their own through the emailed link.
    const passwordHash = await this.passwords.hash(randomBytes(32).toString('base64url'));
    const { restaurantId, ownerId } = await this.prisma.$transaction(
      (tx) => provisionRestaurant(tx, {
        name: input.restaurantName, gstin: input.gstin ?? null, phone: input.phone ?? null, stateCode: input.stateCode, stateName: GST_STATES[input.stateCode]!,
        gstRegistration: input.gstRegistration, createdVia: 'PLATFORM',
        trialEndsAt: input.trialDays > 0 ? new Date(Date.now() + input.trialDays * DAY_MS) : null,
        owner: { name: input.ownerName, email: input.email, phone: input.phone ?? null, passwordHash, emailVerifiedAt: null },
      }),
      { timeout: 20_000 },
    );
    await this.audit.record({ restaurantId }, {
      action: 'restaurant.created', entityType: 'restaurant', entityId: restaurantId, after: { via: 'platform', trialDays: input.trialDays, ...by(admin) },
    });
    await this.sendInvite(ownerId, true);
    return this.detail(admin, restaurantId);
  }

  /** Emails the owner a link to choose a password: the welcome for a new restaurant, or help for one locked out. */
  async invite(admin: PlatformActor, id: string): Promise<void> {
    const restaurant = await this.find(id);
    const owner = await this.ownerOf(id);
    if (!owner) throw new DomainError('NO_OWNER', 'This restaurant has no owner account to send a link to.', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.sendInvite(owner.id, !owner.emailVerifiedAt);
    await this.audit.record({ restaurantId: restaurant.id }, { action: 'platform.password_link_sent', entityType: 'user', entityId: owner.id, after: by(admin) });
  }

  /** Stops everyone at the restaurant from signing in, and signs out those who are. Its data is kept. */
  async suspend(admin: PlatformActor, id: string, reason: string): Promise<PlatformRestaurantDetailDto> {
    const restaurant = await this.find(id);
    if (!restaurant.isActive) throw conflict('ALREADY_SUSPENDED', 'This restaurant is already suspended.');
    await this.prisma.restaurant.update({ where: { id }, data: { isActive: false, suspendedAt: new Date(), suspendReason: reason } });
    const sessions = await this.prisma.session.findMany({ where: { user: { restaurantId: id }, revokedAt: null, expiresAt: { gt: new Date() } }, select: { familyId: true }, distinct: ['familyId'] });
    const families = sessions.map((session) => session.familyId);
    await this.prisma.session.updateMany({ where: { familyId: { in: families }, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.permissionCache.markRevoked(families);
    await this.permissionCache.invalidateRestaurant(id);
    await this.audit.record({ restaurantId: id }, { action: 'platform.suspended', entityType: 'restaurant', entityId: id, reason, after: by(admin) });
    return this.detail(admin, id);
  }

  async reactivate(admin: PlatformActor, id: string): Promise<PlatformRestaurantDetailDto> {
    const restaurant = await this.find(id);
    if (restaurant.isActive) throw conflict('NOT_SUSPENDED', 'This restaurant is not suspended.');
    await this.prisma.restaurant.update({ where: { id }, data: { isActive: true, suspendedAt: null, suspendReason: null } });
    await this.permissionCache.invalidateRestaurant(id);
    await this.audit.record({ restaurantId: id }, {
      action: 'platform.reactivated', entityType: 'restaurant', entityId: id, before: { suspendReason: restaurant.suspendReason }, after: by(admin),
    });
    return this.detail(admin, id);
  }

  /** Moves the end of the free trial, to give a restaurant more time (or less). */
  async setTrial(admin: PlatformActor, id: string, input: z.output<typeof setTrialSchema>): Promise<PlatformRestaurantDetailDto> {
    const restaurant = await this.find(id);
    const trialEndsAt = endOfDay(input.trialEndsOn);
    await this.prisma.restaurant.update({ where: { id }, data: { trialEndsAt } });
    await this.permissionCache.invalidateRestaurant(id);
    await this.audit.record({ restaurantId: id }, {
      action: 'platform.trial_changed', entityType: 'restaurant', entityId: id, reason: input.note,
      before: { trialEndsAt: restaurant.trialEndsAt }, after: { trialEndsAt, ...by(admin) },
    });
    return this.detail(admin, id);
  }

  /** Records that the restaurant has paid up to a date. The note says how, since payment is taken outside the system. */
  async setPaidUntil(admin: PlatformActor, id: string, input: z.output<typeof setPaidUntilSchema>): Promise<PlatformRestaurantDetailDto> {
    const restaurant = await this.find(id);
    const paidUntil = input.paidUntil ? new Date(input.paidUntil + 'T00:00:00.000Z') : null;
    await this.prisma.restaurant.update({ where: { id }, data: { paidUntil } });
    await this.permissionCache.invalidateRestaurant(id);
    await this.audit.record({ restaurantId: id }, {
      action: 'platform.paid_until_changed', entityType: 'restaurant', entityId: id, reason: input.note,
      before: { paidUntil: restaurant.paidUntil?.toISOString().slice(0, 10) ?? null }, after: { paidUntil: input.paidUntil, ...by(admin) },
    });
    return this.detail(admin, id);
  }

  // ── Internals ──

  private async find(id: string): Promise<RestaurantRow> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id } });
    if (!restaurant) throw notFound('Restaurant');
    return restaurant;
  }

  /** The first owner account of a restaurant: the person who registered it, or for whom it was set up. */
  private ownerOf(restaurantId: string) {
    return this.prisma.user.findFirst({ where: { restaurantId, role: { key: 'owner', isSystem: true } }, orderBy: { createdAt: 'asc' } });
  }

  private async summaries(restaurants: RestaurantRow[]): Promise<PlatformRestaurantDto[]> {
    const ids = restaurants.map((restaurant) => restaurant.id);
    if (ids.length === 0) return [];
    const [owners, people, bills] = await Promise.all([
      this.prisma.user.findMany({
        where: { restaurantId: { in: ids }, role: { key: 'owner', isSystem: true } }, orderBy: { createdAt: 'asc' },
        select: { restaurantId: true, name: true, email: true, emailVerifiedAt: true },
      }),
      this.prisma.user.groupBy({ by: ['restaurantId'], where: { restaurantId: { in: ids } }, _count: true, _max: { lastLoginAt: true } }),
      this.prisma.invoice.groupBy({
        by: ['restaurantId'], where: { restaurantId: { in: ids }, status: 'ISSUED', issuedAt: { gte: new Date(Date.now() - 30 * DAY_MS) } }, _count: true, _sum: { totalPaise: true },
      }),
    ]);
    const owner = new Map<string, (typeof owners)[number]>();
    for (const entry of owners) if (!owner.has(entry.restaurantId)) owner.set(entry.restaurantId, entry);
    const peopleOf = new Map(people.map((entry) => [entry.restaurantId, entry]));
    const billsOf = new Map(bills.map((entry) => [entry.restaurantId, entry]));
    return restaurants.map((restaurant) => {
      const first = owner.get(restaurant.id);
      return {
        id: restaurant.id, name: restaurant.name, city: restaurant.city, stateName: restaurant.stateName,
        ownerName: first?.name ?? null, ownerEmail: first?.email ?? null, ownerVerified: Boolean(first?.emailVerifiedAt),
        createdAt: restaurant.createdAt.toISOString(), createdVia: restaurant.createdVia as PlatformRestaurantDto['createdVia'],
        subscription: subscriptionOf(restaurant), suspendReason: restaurant.suspendReason,
        users: peopleOf.get(restaurant.id)?._count ?? 0, lastActiveAt: peopleOf.get(restaurant.id)?._max.lastLoginAt?.toISOString() ?? null,
        billsLast30Days: billsOf.get(restaurant.id)?._count ?? 0, salesLast30DaysPaise: billsOf.get(restaurant.id)?._sum.totalPaise ?? 0,
      };
    });
  }

  private async sendInvite(userId: string, welcome: boolean): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { restaurant: { select: { name: true } } } });
    const { token, hash } = this.tokens.newOpaqueToken();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId, usedAt: null } }),
      this.prisma.passwordResetToken.create({ data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_LINK_DAYS * DAY_MS) } }),
    ]);
    const link = `${env.WEB_URL}/reset-password?token=${token}${welcome ? '&welcome=1' : ''}`;
    const text = welcome
      ? `Hello ${user.name},\n\n${user.restaurant.name} has been set up on ${env.APP_NAME}. Open this link to choose your password and sign in. ` +
        `It works once and for ${INVITE_LINK_DAYS} days.\n\n${link}\n\nYour sign-in email is ${user.email}.`
      : `Hello ${user.name},\n\nOur support team has sent you a link to choose a new password for ${user.restaurant.name}. ` +
        `It works once and for ${INVITE_LINK_DAYS} days.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`;
    try {
      await this.mail.send({ to: user.email, subject: welcome ? `Welcome to ${env.APP_NAME}: choose your password` : `Choose a new ${env.APP_NAME} password`, text });
    } catch (error) {
      this.logger.error('Could not send the password link', error instanceof Error ? error.stack : String(error));
      throw new DomainError('MAIL_FAILED', 'The email could not be sent. Check the mail settings and send the link again.', HttpStatus.BAD_GATEWAY);
    }
  }
}
