import { CleanupService } from '../src/modules/health/cleanup.service.js';
import { scene } from './support/billing.js';
import { createHarness, type Harness } from './support/harness.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('housekeeping', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h.close();
  });

  it('removes expired sessions, spent reset links and old print jobs, and nothing that is still in use', async () => {
    const s = await scene(h);
    const userId = s.fx.owner.id;
    const restaurantId = s.fx.restaurant.id;
    const session = (hash: string, expiresAt: Date) => ({ userId, familyId: crypto.randomUUID(), refreshTokenHash: hash, expiresAt });
    await h.prisma.session.createMany({ data: [session('expired-long-ago', ago(3)), session('expired-this-morning', ago(0.2)), session('valid', ago(-5))] });
    await h.prisma.passwordResetToken.createMany({
      data: [
        { userId, tokenHash: 'expired', expiresAt: ago(2) },
        { userId, tokenHash: 'used', expiresAt: ago(-1), usedAt: ago(2) },
        { userId, tokenHash: 'fresh', expiresAt: ago(-1) },
      ],
    });
    const job = (title: string, status: 'DONE' | 'FAILED' | 'QUEUED', createdAt: Date) => ({ restaurantId, type: 'RECEIPT' as const, status, title, payload: {}, createdAt });
    await h.prisma.printJob.createMany({ data: [job('old done', 'DONE', ago(40)), job('old failed', 'FAILED', ago(31)), job('recent', 'DONE', ago(5)), job('old but waiting', 'QUEUED', ago(40))] });
    const sessionsBefore = await h.prisma.session.count();

    const removed = await h.app.get(CleanupService).run();
    expect(removed).toEqual({ sessions: 1, resetTokens: 2, printJobs: 2 });
    // The two sign-ins made by this test are still good, and so is everything recent.
    expect(await h.prisma.session.count()).toBe(sessionsBefore - 1);
    expect((await h.prisma.session.findMany({ where: { refreshTokenHash: { in: ['expired-long-ago', 'expired-this-morning', 'valid'] } } })).map((row) => row.refreshTokenHash).sort()).toEqual(['expired-this-morning', 'valid']);
    expect((await h.prisma.passwordResetToken.findMany()).map((row) => row.tokenHash)).toEqual(['fresh']);
    expect((await h.prisma.printJob.findMany({ orderBy: { title: 'asc' } })).map((row) => row.title)).toEqual(['old but waiting', 'recent']);
    expect((await s.owner.get('/auth/me')).status).toBe(200);

    // Running it again finds nothing more to remove.
    expect(await h.app.get(CleanupService).run()).toEqual({ sessions: 0, resetTokens: 0, printJobs: 0 });
  });
});
