import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaClient, provisionRestaurant } from '@pos/database';
import { GST_STATES } from '@pos/types';
import type { OnboardingDto, signupSchema } from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PasswordService } from '../../common/auth/password.service.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { TokenService } from '../../common/auth/token.service.js';
import { DomainError } from '../../common/filters/api-exception.filter.js';
import { env } from '../../config/env.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';

const VERIFY_LINK_HOURS = 24;
const DAY_MS = 86_400_000;
const trialEnd = (from = new Date()) => new Date(from.getTime() + env.TRIAL_DAYS * DAY_MS);

/**
 * A restaurant registering itself. The restaurant is created at once, but its owner cannot sign in until they
 * open the link sent to their email, which is also when the free trial starts.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger('Signup');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly permissionCache: PermissionCacheService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Answers the same way whether or not the address already has an account, so it cannot be used to find out
   * who is a customer. Someone who already has one is told so by email instead.
   */
  async signup(input: z.output<typeof signupSchema>): Promise<void> {
    if (!env.SIGNUP_ENABLED) {
      throw new DomainError('SIGNUP_CLOSED', 'New restaurants are set up by our team at the moment. Contact us to get started.', HttpStatus.FORBIDDEN);
    }
    // Hashed in every case, so the time taken does not give the answer away either.
    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.prisma.user.findUnique({ where: { email: input.email }, include: { restaurant: true } });

    if (existing?.emailVerifiedAt) {
      await this.send(input.email, `You already have a ${env.APP_NAME} account`,
        `Hello ${existing.name},\n\nSomeone tried to register a new restaurant with this email address, which already has an account for ` +
        `${existing.restaurant.name}.\n\nSign in here: ${env.WEB_URL}/login\nForgotten your password? ${env.WEB_URL}/forgot-password\n\n` +
        'If this was not you, there is nothing you need to do.');
      return;
    }

    const stateName = GST_STATES[input.stateCode]!;
    let userId: string;
    if (existing) {
      // Registered before but never confirmed. Nobody has proved the address is theirs yet, so the newest details
      // win, and whoever opens the email gets the account.
      userId = existing.id;
      await this.prisma.$transaction([
        this.prisma.restaurant.update({
          where: { id: existing.restaurantId },
          data: { name: input.restaurantName, stateCode: input.stateCode, stateName, gstin: input.gstin ?? null, phone: input.phone, trialEndsAt: trialEnd() },
        }),
        this.prisma.restaurantSettings.update({ where: { restaurantId: existing.restaurantId }, data: { gstRegistration: input.gstRegistration } }),
        this.prisma.user.update({ where: { id: existing.id }, data: { name: input.ownerName, phone: input.phone, passwordHash } }),
      ]);
    } else {
      const created = await this.prisma.$transaction(
        (tx) => provisionRestaurant(tx, {
          name: input.restaurantName, gstin: input.gstin ?? null, phone: input.phone, stateCode: input.stateCode, stateName,
          gstRegistration: input.gstRegistration, trialEndsAt: trialEnd(), createdVia: 'SIGNUP',
          owner: { name: input.ownerName, email: input.email, phone: input.phone, passwordHash, emailVerifiedAt: null },
        }),
        { timeout: 20_000 },
      );
      userId = created.ownerId;
    }
    await this.sendVerification(userId, input.email, input.ownerName);
  }

  /** Confirms the address and starts the trial. Returns the email so the sign-in page can fill it in. */
  async verify(token: string): Promise<{ email: string }> {
    const record = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash: this.tokens.hash(token) }, include: { user: true } });
    if (!record || record.expiresAt <= new Date()) {
      throw new DomainError('VERIFY_LINK_INVALID', 'This link is invalid or has expired. Ask for a new one.', HttpStatus.BAD_REQUEST);
    }
    const { user } = record;
    if (!user.emailVerifiedAt) {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } }),
        // The trial is counted from the day the owner can actually sign in.
        this.prisma.restaurant.update({ where: { id: user.restaurantId }, data: { trialEndsAt: trialEnd(now) } }),
        this.prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
      ]);
      await this.permissionCache.invalidateRestaurant(user.restaurantId);
      await this.audit.record({ restaurantId: user.restaurantId, userId: user.id }, {
        action: 'restaurant.created', entityType: 'restaurant', entityId: user.restaurantId, after: { via: 'sign-up', trialDays: env.TRIAL_DAYS },
      });
    }
    return { email: user.email };
  }

  /** Sends the link again. Says nothing about whether the address is known. */
  async resend(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt || !user.isActive) return;
    await this.sendVerification(user.id, user.email, user.name);
  }

  // ── Getting started ──

  async onboarding(auth: AuthContext): Promise<OnboardingDto> {
    const restaurantId = auth.restaurantId;
    const [restaurant, products, tables, people, bills] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
      this.prisma.product.count({ where: { restaurantId, deletedAt: null } }),
      this.prisma.diningTable.count({ where: { restaurantId } }),
      this.prisma.user.count({ where: { restaurantId } }),
      this.prisma.invoice.count({ where: { restaurantId } }),
    ]);
    return {
      dismissed: restaurant.onboardingDismissedAt !== null,
      steps: { details: Boolean(restaurant.addressLine1 && restaurant.city), menu: products > 0, tables: tables > 0, staff: people > 1, firstBill: bills > 0 },
    };
  }

  async dismissOnboarding(auth: AuthContext): Promise<OnboardingDto> {
    await this.prisma.restaurant.updateMany({ where: { id: auth.restaurantId, onboardingDismissedAt: null }, data: { onboardingDismissedAt: new Date() } });
    return this.onboarding(auth);
  }

  // ── Internals ──

  private async sendVerification(userId: string, email: string, name: string): Promise<void> {
    const { token, hash } = this.tokens.newOpaqueToken();
    await this.prisma.$transaction([
      // Only the newest link works.
      this.prisma.emailVerificationToken.deleteMany({ where: { userId } }),
      this.prisma.emailVerificationToken.create({ data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + VERIFY_LINK_HOURS * 3_600_000) } }),
    ]);
    await this.send(email, `Confirm your email for ${env.APP_NAME}`,
      `Hello ${name},\n\nThank you for registering. Open this link to confirm your email address and start your ${env.TRIAL_DAYS}-day free trial. ` +
      `It works for ${VERIFY_LINK_HOURS} hours.\n\n${env.WEB_URL}/verify-email?token=${token}\n\nIf you did not register, you can ignore this email.`);
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.mail.send({ to, subject, text });
    } catch (error) {
      // The caller is told the same thing either way; the person can ask for the email again.
      this.logger.error('Could not send "' + subject + '"', error instanceof Error ? error.stack : String(error));
    }
  }
}
