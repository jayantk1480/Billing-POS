import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import type {
  AuthResponse, AuthUser, ChangePasswordInput, ClientApp, LoginInput, PinLoginInput, PinUser, SessionInfo,
} from '@pos/validation';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PasswordService } from '../../common/auth/password.service.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { TokenService } from '../../common/auth/token.service.js';
import { DomainError } from '../../common/filters/api-exception.filter.js';
import { env } from '../../config/env.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RESET_TOKEN_MINUTES = 30;
// Two tabs can refresh with the same cookie at once; within this window that is not treated as theft.
const ROTATION_GRACE_MS = 10_000;

const userInclude = { role: true, restaurant: { select: { id: true, name: true, isActive: true } } } satisfies Prisma.UserInclude;
type UserWithRole = Prisma.UserGetPayload<{ include: typeof userInclude }>;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  response: AuthResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const invalidCredentials = () =>
  new DomainError('INVALID_CREDENTIALS', 'Incorrect email or password.', HttpStatus.UNAUTHORIZED);
const sessionEnded = () => new UnauthorizedException('Your session has ended. Sign in again.');

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly permissionCache: PermissionCacheService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ── Sign in ──

  async login(input: LoginInput, meta: RequestMeta): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email }, include: userInclude });
    if (!user || !user.isActive) {
      await this.passwords.verifyDecoy(input.password);
      throw invalidCredentials();
    }
    this.assertNotLocked(user);

    if (!(await this.passwords.verify(user.passwordHash, input.password))) {
      await this.registerFailure(user, 'auth.login_failed', meta);
      throw invalidCredentials();
    }
    // Checked only once the password is right, so the answers give nothing away about an account.
    if (!user.emailVerifiedAt) {
      throw new DomainError('EMAIL_NOT_VERIFIED', 'Confirm your email address first. Open the link we sent you, or ask for a new one.', HttpStatus.FORBIDDEN);
    }
    if (!user.restaurant.isActive) {
      throw new DomainError('RESTAURANT_SUSPENDED', 'This restaurant\'s account has been suspended. Contact support to restore it.', HttpStatus.FORBIDDEN);
    }
    await this.assertMayUse(user, input.client);

    let terminalId: string | null = null;
    if (input.terminalId) {
      const terminal = await this.prisma.terminal.findFirst({
        where: { id: input.terminalId, restaurantId: user.restaurantId, isActive: true, kind: 'COUNTER' },
      });
      if (!terminal) throw new DomainError('TERMINAL_NOT_FOUND', 'This terminal is not registered or is inactive.');
      terminalId = terminal.id;
      await this.prisma.terminal.update({ where: { id: terminal.id }, data: { lastSeenAt: new Date() } });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const issued = await this.issue(user, { client: input.client, terminalId, meta });
    await this.audit.record(this.actor(user, meta, terminalId), {
      action: 'auth.login', entityType: 'user', entityId: user.id, after: { client: input.client },
    });
    return issued;
  }

  /** Exchanges a refresh token for a new one. A token that is presented twice ends the whole session. */
  async refresh(rawToken: string | undefined, client: ClientApp, meta: RequestMeta): Promise<IssuedSession> {
    const session = await this.findCookieSession(rawToken, client);
    if (session.lockedAt) {
      throw new DomainError('SESSION_LOCKED', 'This terminal is locked. Enter your PIN to continue.', HttpStatus.UNAUTHORIZED);
    }
    if (session.rotatedAt) {
      if (Date.now() - session.rotatedAt.getTime() > ROTATION_GRACE_MS && !(await this.retryAfterLostAnswer(session, meta))) {
        await this.revokeFamilies([session.familyId]);
        await this.audit.record(this.actor(session.user, meta, session.terminalId), {
          action: 'auth.refresh_token_reuse', entityType: 'session', entityId: session.familyId,
        });
        throw sessionEnded();
      }
    } else {
      await this.prisma.session.updateMany({ where: { id: session.id, rotatedAt: null }, data: { rotatedAt: new Date() } });
    }
    // A role can lose back-office access while one of its people is signed in there.
    await this.assertMayUse(session.user, client).catch(async (error: unknown) => {
      await this.revokeFamilies([session.familyId]);
      throw error;
    });
    return this.issue(session.user, { client, terminalId: session.terminalId, familyId: session.familyId, meta });
  }

  /**
   * A connection that drops while a renewal is on its way leaves the browser holding the token it just gave up: the
   * answer carrying the new one never arrived. That is told apart from a copied token being used: the token that
   * replaced it has never been used, and the request comes from the same browser it was issued to. Allowed once: both
   * the old token and its unused replacement stop working, so a second use of the old token ends the session as before.
   */
  private async retryAfterLostAnswer(session: { id: string; familyId: string; createdAt: Date; userAgent: string | null }, meta: RequestMeta): Promise<boolean> {
    const newer = await this.prisma.session.findMany({ where: { familyId: session.familyId, createdAt: { gt: session.createdAt } } });
    const replacement = newer[0];
    if (newer.length !== 1 || !replacement || replacement.rotatedAt || replacement.revokedAt || !session.userAgent || replacement.userAgent !== (meta.userAgent?.slice(0, 300) ?? null)) {
      return false;
    }
    // Only one request can take this path: the second finds the old token already retired.
    const retired = await this.prisma.session.updateMany({ where: { id: { in: [session.id, replacement.id] }, revokedAt: null }, data: { revokedAt: new Date() } });
    return retired.count === 2;
  }

  /** The back office is only for roles that were given it; a biller's account works on the billing screen alone. */
  private async assertMayUse(user: { roleId: string }, client: ClientApp): Promise<void> {
    if (client !== 'web') return;
    if ((await this.permissionCache.rolePermissions(user.roleId)).includes('backoffice.access')) return;
    throw new DomainError(
      'BACKOFFICE_NOT_ALLOWED', 'This account is for billing only. Sign in on the billing (POS) screen instead.', HttpStatus.FORBIDDEN,
    );
  }

  /** Ties this device's session to a billing terminal, so its orders and invoices use that terminal's series. */
  async selectTerminal(auth: AuthContext, rawToken: string | undefined, client: ClientApp, terminalId: string, meta: RequestMeta): Promise<IssuedSession> {
    const terminal = await this.prisma.terminal.findFirst({ where: { id: terminalId, restaurantId: auth.restaurantId, isActive: true, kind: 'COUNTER' } });
    if (!terminal) throw new DomainError('TERMINAL_NOT_FOUND', 'This terminal is not registered or is inactive.');
    const session = await this.findCookieSession(rawToken, client);
    if (session.familyId !== auth.sessionId) throw sessionEnded();
    await this.prisma.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { terminalId } });
    await this.prisma.terminal.update({ where: { id: terminalId }, data: { lastSeenAt: new Date() } });
    return this.refresh(rawToken, client, meta);
  }

  /** Switches the signed-in user on a shared terminal. The terminal must already hold a session. */
  async pinLogin(rawToken: string | undefined, input: PinLoginInput, meta: RequestMeta): Promise<IssuedSession> {
    const device = await this.findCookieSession(rawToken, input.client);
    const invalidPin = () => new DomainError('INVALID_PIN', 'Incorrect PIN.', HttpStatus.UNAUTHORIZED);

    const user = await this.prisma.user.findFirst({
      where: { id: input.userId, restaurantId: device.user.restaurantId, isActive: true, pinHash: { not: null } },
      include: userInclude,
    });
    if (!user?.pinHash) {
      await this.passwords.verifyDecoy(input.pin);
      throw invalidPin();
    }
    this.assertNotLocked(user);
    if (!(await this.passwords.verify(user.pinHash, input.pin))) {
      await this.registerFailure(user, 'auth.pin_failed', meta);
      throw invalidPin();
    }
    await this.assertMayUse(user, input.client);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.revokeFamilies([device.familyId]);
    const issued = await this.issue(user, { client: input.client, terminalId: device.terminalId, meta });
    await this.audit.record(this.actor(user, meta, device.terminalId), {
      action: 'auth.pin_login', entityType: 'user', entityId: user.id,
    });
    return issued;
  }

  /** Users who can sign in by PIN on the terminal holding this cookie. */
  async pinUsers(rawToken: string | undefined, client: ClientApp): Promise<PinUser[]> {
    const device = await this.findCookieSession(rawToken, client);
    const users = await this.prisma.user.findMany({
      where: { restaurantId: device.user.restaurantId, isActive: true, pinHash: { not: null } },
      include: { role: true },
      orderBy: { name: 'asc' },
    });
    return users.map((user) => ({ id: user.id, name: user.name, roleName: user.role.name }));
  }

  /** Locks the terminal: the access token stops working and only a PIN sign-in is accepted. */
  async lock(auth: AuthContext): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId: auth.sessionId, revokedAt: null, rotatedAt: null },
      data: { lockedAt: new Date() },
    });
    await this.permissionCache.markRevoked([auth.sessionId]);
  }

  async logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!rawToken) return;
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.tokens.hash(rawToken) },
      include: { user: true },
    });
    if (!session) return;
    await this.revokeFamilies([session.familyId]);
    await this.audit.record(this.actor(session.user, meta, session.terminalId), {
      action: 'auth.logout', entityType: 'user', entityId: session.userId,
    });
  }

  async me(auth: AuthContext): Promise<AuthUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: userInclude });
    return this.toAuthUser(user, auth.terminalId);
  }

  // ── Passwords ──

  /** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return;

    const { token, hash } = this.tokens.newOpaqueToken();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000) },
      }),
    ]);

    const link = `${env.WEB_URL}/reset-password?token=${token}`;
    try {
      await this.mail.send({
        to: user.email,
        subject: `Reset your ${env.APP_NAME} password`,
        text:
          `Hello ${user.name},\n\nUse this link to choose a new password. It works once and expires in ` +
          `${RESET_TOKEN_MINUTES} minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    } catch (error) {
      this.logger.error('Could not send password reset email', error instanceof Error ? error.stack : String(error));
    }
    await this.audit.record({ restaurantId: user.restaurantId, userId: user.id }, {
      action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
      include: { user: true },
    });
    if (!record || record.usedAt || record.expiresAt <= new Date() || !record.user.isActive) {
      throw new DomainError('RESET_LINK_INVALID', 'This reset link is invalid or has expired. Request a new one.', HttpStatus.BAD_REQUEST);
    }
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        // Opening a link sent to the address proves it is theirs, which is all email confirmation asks.
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: record.user.emailVerifiedAt ?? new Date() },
      }),
      this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    await this.revokeUserSessions(record.userId);
    await this.audit.record({ restaurantId: record.user.restaurantId, userId: record.userId }, {
      action: 'auth.password_reset', entityType: 'user', entityId: record.userId,
    });
  }

  async changePassword(auth: AuthContext, input: ChangePasswordInput): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      throw new DomainError('CURRENT_PASSWORD_WRONG', 'Your current password is incorrect.', HttpStatus.BAD_REQUEST);
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.passwords.hash(input.newPassword) } });
    await this.revokeUserSessions(user.id, auth.sessionId);
    await this.audit.record(auth, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
  }

  // ── Sessions ──

  async listSessions(auth: AuthContext): Promise<SessionInfo[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId: auth.userId, revokedAt: null, rotatedAt: null, expiresAt: { gt: new Date() } },
      include: { terminal: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const seen = new Set<string>();
    return sessions
      .filter((session) => !seen.has(session.familyId) && seen.add(session.familyId))
      .map((session) => ({
        id: session.familyId,
        client: session.client,
        userAgent: session.userAgent,
        ip: session.ip,
        terminalName: session.terminal?.name ?? null,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        current: session.familyId === auth.sessionId,
      }));
  }

  async revokeSession(auth: AuthContext, familyId: string): Promise<void> {
    const owned = await this.prisma.session.findFirst({ where: { familyId, userId: auth.userId } });
    if (!owned) throw new DomainError('SESSION_NOT_FOUND', 'Session not found.', HttpStatus.NOT_FOUND);
    await this.revokeFamilies([familyId]);
    await this.audit.record(auth, { action: 'auth.session_revoked', entityType: 'session', entityId: familyId });
  }

  /** Signs a user out everywhere, optionally keeping one session (the one making the change). */
  async revokeUserSessions(userId: string, exceptFamilyId?: string): Promise<void> {
    const active = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await this.revokeFamilies(active.map((session) => session.familyId).filter((id) => id !== exceptFamilyId));
  }

  // ── Internals ──

  private async revokeFamilies(familyIds: string[]): Promise<void> {
    if (familyIds.length === 0) return;
    await this.prisma.session.updateMany({
      where: { familyId: { in: familyIds }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.permissionCache.markRevoked(familyIds);
  }

  /** Loads the live session behind a refresh cookie, or rejects the request. */
  private async findCookieSession(rawToken: string | undefined, client: ClientApp) {
    if (!rawToken) throw sessionEnded();
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.tokens.hash(rawToken) },
      include: { user: { include: userInclude } },
    });
    if (
      !session || session.client !== client || session.revokedAt || session.expiresAt <= new Date() ||
      !session.user.isActive || !session.user.restaurant.isActive
    ) {
      throw sessionEnded();
    }
    return session;
  }

  private async issue(
    user: UserWithRole,
    options: { client: ClientApp; terminalId: string | null; familyId?: string; meta: RequestMeta },
  ): Promise<IssuedSession> {
    const { token, hash } = this.tokens.newOpaqueToken();
    const familyId = options.familyId ?? randomUUID();
    const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.prisma.session.create({
      data: {
        userId: user.id,
        terminalId: options.terminalId,
        familyId,
        refreshTokenHash: hash,
        client: options.client,
        userAgent: options.meta.userAgent?.slice(0, 300) ?? null,
        ip: options.meta.ip,
        expiresAt: refreshExpiresAt,
      },
    });
    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      restaurantId: user.restaurantId,
      roleId: user.roleId,
      sessionId: familyId,
      terminalId: options.terminalId,
    });
    return {
      response: {
        accessToken,
        expiresIn: env.JWT_ACCESS_TTL_SECONDS,
        user: await this.toAuthUser(user, options.terminalId),
      },
      refreshToken: token,
      refreshExpiresAt,
    };
  }

  private async toAuthUser(user: UserWithRole, terminalId: string | null): Promise<AuthUser> {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      restaurantId: user.restaurantId,
      restaurantName: user.restaurant.name,
      role: { id: user.role.id, key: user.role.key, name: user.role.name },
      permissions: await this.permissionCache.rolePermissions(user.roleId),
      sharedReports: (await this.prisma.reportShare.findMany({ where: { userId: user.id }, select: { reportType: true } })).map((share) => share.reportType),
      terminalId,
    };
  }

  private assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new DomainError(
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async registerFailure(user: UserWithRole, action: string, meta: RequestMeta): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const locked = updated.failedLoginCount >= MAX_FAILED_ATTEMPTS;
    if (locked) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      });
    }
    await this.audit.record(this.actor(user, meta, null), {
      action, entityType: 'user', entityId: user.id, after: { locked },
    });
  }

  private actor(user: { id: string; restaurantId: string }, meta: RequestMeta, terminalId: string | null) {
    return { restaurantId: user.restaurantId, userId: user.id, terminalId, ip: meta.ip };
  }
}
