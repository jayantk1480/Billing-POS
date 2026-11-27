import { type CanActivate, createParamDecorator, type ExecutionContext, ForbiddenException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@pos/database';
import type { PlatformAdminDto, PlatformLoginInput } from '@pos/validation';
import type { Request } from 'express';
import { PasswordService } from '../../common/auth/password.service.js';
import { TokenService } from '../../common/auth/token.service.js';
import { DomainError } from '../../common/filters/api-exception.filter.js';
import { env } from '../../config/env.js';

export const PLATFORM_COOKIE = 'pos_platform';
/** The cookie is only ever sent to the platform routes. */
export const PLATFORM_COOKIE_PATH = '/api/v1/platform';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
/** A platform session ends after this long whatever happens, and sooner if it sits unused. */
const SESSION_HOURS = 12;
const IDLE_MINUTES = 120;

export interface PlatformActor extends PlatformAdminDto {
  sessionId: string;
}
type PlatformRequest = Request & { platformAdmin?: PlatformActor };

/** The signed-in platform admin. Only on routes behind PlatformGuard. */
export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext): PlatformActor => {
  const admin = context.switchToHttp().getRequest<PlatformRequest>().platformAdmin;
  if (!admin) throw new Error('CurrentAdmin used on a route without PlatformGuard');
  return admin;
});

/**
 * The platform routes are for the admin app and nothing else. A browser on any other site cannot use them even
 * with a platform admin's cookie present (SameSite=Strict on the cookie is the second lock on the same door).
 */
@Injectable()
export class PlatformOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.switchToHttp().getRequest<Request>().headers.origin !== env.ADMIN_URL) {
      throw new ForbiddenException('This request is not allowed from this origin.');
    }
    return true;
  }
}

/**
 * Sign-in for the vendor's own people. They are a separate kind of account from restaurant users: a platform
 * session opens only the platform routes, and a restaurant sign-in never opens those.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(input: PlatformLoginInput, meta: { ip: string | null; userAgent: string | null }): Promise<{ admin: PlatformAdminDto; token: string; expiresAt: Date }> {
    const invalid = () => new DomainError('INVALID_CREDENTIALS', 'Incorrect email or password.', HttpStatus.UNAUTHORIZED);
    const admin = await this.prisma.platformAdmin.findUnique({ where: { email: input.email } });
    if (!admin || !admin.isActive) {
      await this.passwords.verifyDecoy(input.password);
      throw invalid();
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new DomainError('ACCOUNT_LOCKED', 'Too many wrong passwords. Try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await this.passwords.verify(admin.passwordHash, input.password))) {
      const failures = admin.failedLoginCount + 1;
      const lock = failures >= MAX_FAILED_ATTEMPTS;
      await this.prisma.platformAdmin.update({
        where: { id: admin.id },
        data: { failedLoginCount: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      throw invalid();
    }
    const { token, hash } = this.tokens.newOpaqueToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    await this.prisma.$transaction([
      this.prisma.platformAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } }),
      this.prisma.platformSession.create({ data: { adminId: admin.id, tokenHash: hash, expiresAt, ip: meta.ip, userAgent: meta.userAgent } }),
      // Sessions that have run out are of no use to anyone.
      this.prisma.platformSession.deleteMany({ where: { adminId: admin.id, expiresAt: { lt: new Date() } } }),
    ]);
    return { admin: { id: admin.id, name: admin.name, email: admin.email }, token, expiresAt };
  }

  /** The admin a session cookie belongs to, or null. Using a session keeps it alive; leaving it idle ends it. */
  async resolve(token: string | undefined): Promise<PlatformActor | null> {
    if (!token) return null;
    const session = await this.prisma.platformSession.findUnique({ where: { tokenHash: this.tokens.hash(token) }, include: { admin: true } });
    if (!session || !session.admin.isActive) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || now - session.lastUsedAt.getTime() > IDLE_MINUTES * 60_000) {
      await this.prisma.platformSession.deleteMany({ where: { id: session.id } });
      return null;
    }
    if (now - session.lastUsedAt.getTime() > 60_000) {
      await this.prisma.platformSession.updateMany({ where: { id: session.id }, data: { lastUsedAt: new Date(now) } });
    }
    return { id: session.admin.id, name: session.admin.name, email: session.admin.email, sessionId: session.id };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.prisma.platformSession.deleteMany({ where: { tokenHash: this.tokens.hash(token) } });
  }
}

/** Admits a signed-in platform admin, from the admin app only. */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly auth: PlatformAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlatformRequest>();
    if (req.headers.origin !== env.ADMIN_URL) throw new ForbiddenException('This request is not allowed from this origin.');
    const admin = await this.auth.resolve((req.cookies as Record<string, string> | undefined)?.[PLATFORM_COOKIE]);
    if (!admin) throw new UnauthorizedException('Sign in to continue.');
    req.platformAdmin = admin;
    return true;
  }
}
