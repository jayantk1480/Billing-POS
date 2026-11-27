import { Injectable } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import { PERMISSIONS, PERMISSION_KEYS, type PermissionKey } from '@pos/types';
import type { PermissionDto, RoleDto, UserDto } from '@pos/validation';
import type { z } from 'zod';
import type { createRoleSchema, createUserSchema, updateRoleSchema, updateUserSchema } from '@pos/validation';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PasswordService } from '../../common/auth/password.service.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';

type UserRow = Prisma.UserGetPayload<{ include: { role: true } }>;
type RoleRow = Prisma.RoleGetPayload<{ include: { permissions: { include: { permission: true } }; _count: { select: { users: true } } } }>;
const roleInclude = { permissions: { include: { permission: true } }, _count: { select: { users: true } } } as const;

const toUserDto = (user: UserRow): UserDto => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  isActive: user.isActive,
  hasPin: user.pinHash !== null,
  role: { id: user.role.id, key: user.role.key, name: user.role.name },
  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});

const toRoleDto = (role: RoleRow): RoleDto => ({
  id: role.id,
  key: role.key,
  name: role.name,
  isSystem: role.isSystem,
  // Always in the catalogue's order, so the list is stable however it was saved.
  permissions: PERMISSION_KEYS.filter((key) => role.permissions.some((row) => row.permission.key === key)),
  userCount: role._count.users,
});

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly passwords: PasswordService,
    private readonly permissionCache: PermissionCacheService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  // ── Users ──

  async listUsers(auth: AuthContext): Promise<UserDto[]> {
    const users = await this.prisma.user.findMany({
      where: { restaurantId: auth.restaurantId },
      include: { role: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return users.map(toUserDto);
  }

  async createUser(auth: AuthContext, input: z.output<typeof createUserSchema>): Promise<UserDto> {
    await this.assertCanGrantRole(auth, input.roleId);
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) {
      throw conflict('EMAIL_TAKEN', 'A user with this email already exists.');
    }
    const user = await this.prisma.user.create({
      data: {
        restaurantId: auth.restaurantId,
        roleId: input.roleId,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        passwordHash: await this.passwords.hash(input.password),
        pinHash: input.pin ? await this.passwords.hash(input.pin) : null,
      },
      include: { role: true },
    });
    await this.audit.record(auth, { action: 'user.created', entityType: 'user', entityId: user.id, after: toUserDto(user) });
    return toUserDto(user);
  }

  async updateUser(auth: AuthContext, id: string, input: z.output<typeof updateUserSchema>): Promise<UserDto> {
    const user = await this.prisma.user.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { role: true } });
    if (!user) throw notFound('User');
    // Nobody may edit an account that holds more access than they do.
    await this.assertCanGrantRole(auth, user.roleId);

    const roleChanges = input.roleId !== undefined && input.roleId !== user.roleId;
    const deactivates = input.isActive === false && user.isActive;
    if (id === auth.userId && (roleChanges || deactivates)) {
      throw invalid('CANNOT_CHANGE_SELF', 'You cannot change your own role or deactivate your own account.');
    }
    if (roleChanges) await this.assertCanGrantRole(auth, input.roleId!);
    if ((roleChanges || deactivates) && user.role.key === 'owner') {
      const otherOwners = await this.prisma.user.count({
        where: { restaurantId: auth.restaurantId, isActive: true, role: { key: 'owner' }, id: { not: id } },
      });
      if (otherOwners === 0) throw invalid('LAST_OWNER', 'The restaurant must keep at least one active owner.');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: input.name,
        phone: input.phone,
        roleId: input.roleId,
        isActive: input.isActive,
        passwordHash: input.password ? await this.passwords.hash(input.password) : undefined,
        pinHash: input.pin === undefined ? undefined : input.pin === null ? null : await this.passwords.hash(input.pin),
        ...(input.password || input.isActive === true ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
      include: { role: true },
    });

    // Anything that changes what the account may do, or its password, ends its sessions.
    if (roleChanges || deactivates || input.password) {
      await this.authService.revokeUserSessions(id, id === auth.userId ? auth.sessionId : undefined);
    }
    await this.audit.record(auth, {
      action: 'user.updated', entityType: 'user', entityId: id, before: toUserDto(user),
      after: { ...toUserDto(updated), passwordChanged: Boolean(input.password), pinChanged: input.pin !== undefined },
    });
    return toUserDto(updated);
  }

  // ── Roles ──

  listPermissions(): PermissionDto[] {
    return PERMISSION_KEYS.map((key) => ({ key, ...PERMISSIONS[key] }));
  }

  async listRoles(auth: AuthContext): Promise<RoleDto[]> {
    const roles = await this.prisma.role.findMany({
      where: { restaurantId: auth.restaurantId },
      include: roleInclude,
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
    });
    return roles.map(toRoleDto);
  }

  async createRole(auth: AuthContext, input: z.output<typeof createRoleSchema>): Promise<RoleDto> {
    this.assertHolds(auth, input.permissions);
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'role';
    const taken = new Set(
      (await this.prisma.role.findMany({ where: { restaurantId: auth.restaurantId }, select: { key: true } })).map((r) => r.key),
    );
    let key = base;
    for (let suffix = 2; taken.has(key); suffix += 1) key = `${base}-${suffix}`;

    const role = await this.prisma.role.create({
      data: {
        restaurantId: auth.restaurantId,
        key,
        name: input.name,
        permissions: { create: await this.permissionLinks(input.permissions) },
      },
      include: roleInclude,
    });
    await this.audit.record(auth, { action: 'role.created', entityType: 'role', entityId: role.id, after: toRoleDto(role) });
    return toRoleDto(role);
  }

  async updateRole(auth: AuthContext, id: string, input: z.output<typeof updateRoleSchema>): Promise<RoleDto> {
    const role = await this.findRole(auth, id);
    if (role.key === 'owner') throw invalid('OWNER_ROLE_FIXED', 'The Owner role always has every permission and cannot be changed.');
    if (input.permissions) this.assertHolds(auth, input.permissions);
    const links = input.permissions ? await this.permissionLinks(input.permissions) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (links) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: links.map((link) => ({ roleId: id, ...link })) });
      }
      return tx.role.update({ where: { id }, data: { name: input.name }, include: roleInclude });
    });
    await this.permissionCache.invalidateRole(id);
    await this.audit.record(auth, {
      action: 'role.updated', entityType: 'role', entityId: id, before: toRoleDto(role), after: toRoleDto(updated),
    });
    return toRoleDto(updated);
  }

  async deleteRole(auth: AuthContext, id: string): Promise<void> {
    const role = await this.findRole(auth, id);
    if (role.isSystem) throw invalid('SYSTEM_ROLE', 'Built-in roles cannot be deleted.');
    if (role._count.users > 0) {
      throw conflict('ROLE_IN_USE', `Move the ${role._count.users} user(s) with this role to another role first.`);
    }
    await this.prisma.role.delete({ where: { id } });
    await this.permissionCache.invalidateRole(id);
    await this.audit.record(auth, { action: 'role.deleted', entityType: 'role', entityId: id, before: toRoleDto(role) });
  }

  // ── Internals ──

  private async findRole(auth: AuthContext, id: string): Promise<RoleRow> {
    const role = await this.prisma.role.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: roleInclude });
    if (!role) throw notFound('Role');
    return role;
  }

  private async permissionLinks(keys: PermissionKey[]): Promise<{ permissionId: string }[]> {
    const rows = await this.prisma.permission.findMany({ where: { key: { in: [...new Set(keys)] } }, select: { id: true } });
    return rows.map((row) => ({ permissionId: row.id }));
  }

  /** Stops privilege escalation: you can only hand out permissions you hold yourself. */
  private assertHolds(auth: AuthContext, permissions: PermissionKey[]): void {
    if (permissions.some((permission) => !auth.permissions.has(permission))) {
      throw forbidden('You cannot grant permissions that you do not have yourself.');
    }
  }

  private async assertCanGrantRole(auth: AuthContext, roleId: string): Promise<void> {
    const role = await this.findRole(auth, roleId);
    this.assertHolds(auth, role.permissions.map((row) => row.permission.key as PermissionKey));
  }
}
