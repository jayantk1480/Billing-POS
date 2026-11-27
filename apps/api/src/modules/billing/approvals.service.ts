import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaClient } from '@pos/database';
import type { PermissionKey } from '@pos/types';
import type { ApprovalInput } from '@pos/validation';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PasswordService } from '../../common/auth/password.service.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { DomainError } from '../../common/filters/api-exception.filter.js';
import { RateLimiter } from '../../common/rate-limit/rate-limit.js';

/**
 * Lets a cashier do something beyond their role when a manager enters their PIN at the terminal.
 * The manager, not the cashier, is recorded as the approver.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly passwords: PasswordService,
    private readonly permissionCache: PermissionCacheService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Returns null when the caller holds the permission themselves, or the approving manager's id.
   * Throws APPROVAL_REQUIRED when neither applies, so the POS knows to ask for a manager PIN.
   */
  async resolve(auth: AuthContext, permission: PermissionKey, approval?: ApprovalInput): Promise<string | null> {
    if (auth.permissions.has(permission)) return null;
    if (!approval) {
      throw new DomainError('APPROVAL_REQUIRED', 'A manager needs to approve this.', HttpStatus.FORBIDDEN, { permission });
    }
    const invalid = () => new DomainError('APPROVAL_INVALID', 'That PIN is not correct, or that person cannot approve this.', HttpStatus.FORBIDDEN, { permission });

    // Guessing a four-digit PIN must not be practical: five tries per approver every fifteen minutes.
    const key = `approval:${auth.restaurantId}:${approval.userId}`;
    if ((await this.limiter.consume(key, 5, 900)) > 0) {
      throw new DomainError('APPROVAL_LOCKED', 'Too many wrong PINs. Try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const approver = await this.prisma.user.findFirst({
      where: { id: approval.userId, restaurantId: auth.restaurantId, isActive: true, pinHash: { not: null } },
    });
    if (!approver?.pinHash || !(await this.passwords.verify(approver.pinHash, approval.pin))) throw invalid();
    if (!(await this.permissionCache.rolePermissions(approver.roleId)).includes(permission)) throw invalid();
    await this.limiter.reset(key);
    return approver.id;
  }
}
