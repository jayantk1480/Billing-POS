import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@pos/database';
import { env } from '../../config/env.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Removes rows that have served their purpose: sign-in sessions and password-reset links that expired, and
 * print jobs that finished long ago. Nothing a report, a bill or the audit log relies on is touched.
 */
@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Cleanup');
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaClient) {}

  onModuleInit(): void {
    // Tests call run() themselves.
    if (env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.run().catch((error) => this.logger.warn('Cleanup failed: ' + (error instanceof Error ? error.message : String(error)))), HOUR);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async run(now = new Date()): Promise<{ sessions: number; resetTokens: number; printJobs: number }> {
    // Links and platform sessions that have run out: of no use, and not counted in the result.
    await this.prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.prisma.platformSession.deleteMany({ where: { expiresAt: { lt: now } } });
    const before = (age: number) => new Date(now.getTime() - age);
    const [sessions, resetTokens, printJobs] = await Promise.all([
      // An expired session can no longer be renewed, so nothing is lost; it is kept one more day for the session list.
      this.prisma.session.deleteMany({ where: { expiresAt: { lt: before(DAY) } } }),
      this.prisma.passwordResetToken.deleteMany({ where: { OR: [{ expiresAt: { lt: before(DAY) } }, { usedAt: { lt: before(DAY) } }] } }),
      // A finished job carries a whole printout; the bill or ticket it printed is kept where it belongs.
      this.prisma.printJob.deleteMany({ where: { status: { in: ['DONE', 'FAILED'] }, createdAt: { lt: before(30 * DAY) } } }),
    ]);
    const removed = { sessions: sessions.count, resetTokens: resetTokens.count, printJobs: printJobs.count };
    if (removed.sessions + removed.resetTokens + removed.printJobs > 0) {
      this.logger.log('Removed ' + removed.sessions + ' expired sessions, ' + removed.resetTokens + ' reset links and ' + removed.printJobs + ' old print jobs.');
    }
    return removed;
  }
}
