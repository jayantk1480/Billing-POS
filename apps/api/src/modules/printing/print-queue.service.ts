import { Injectable, Logger } from '@nestjs/common';
import { type Prisma, PrismaClient } from '@pos/database';
import { type BridgeJob, PAPER_COLUMNS, type PaperWidthKey, type PrintDocument, REALTIME_EVENTS } from '@pos/types';
import type { bridgeResultSchema, Page, PrintJobDto, printJobQuerySchema } from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { renderTestPage } from '@pos/printing';
import { PrintingService } from './printing.service.js';

type JobType = 'RECEIPT' | 'KOT' | 'CREDIT_NOTE' | 'REGISTER_REPORT' | 'TEST';

export interface QueueRequest {
  type: JobType;
  /** Which kind of printer it goes to when none is named. */
  role: 'RECEIPT' | 'KOT';
  refType: string | null;
  refId: string | null;
  /** What the print queue shows, e.g. "Bill A1/2627/000007". */
  title: string;
  /** Send it to this printer, whatever the usual one is. */
  printerId?: string | undefined;
  /** For a kitchen ticket: the station it is for, which decides the printer. */
  stationId?: string | null;
  isReprint?: boolean;
  requestedById: string | null;
  /** Lays the printout out for paper that holds this many characters per line. */
  render: (columns: number) => PrintDocument;
}

/** A job carries the printout laid out for both paper widths, since the fallback printer may take the other one. */
interface JobPayload {
  documents: Record<PaperWidthKey, PrintDocument>;
  fallbackPrinterId: string | null;
}

const jobInclude = { printer: { select: { name: true } } } as const;
type JobRow = Prisma.PrintJobGetPayload<{ include: typeof jobInclude }>;

/** A printer is tried this many times before the fallback printer, or failure. */
const MAX_ATTEMPTS = 3;
/** A job the bridge took and never reported on is handed out again after this long. */
const CLAIM_TIMEOUT_SECONDS = 45;
/** A kitchen ticket that prints an hour late does harm, so a job nobody could print is given up on. */
const EXPIRY_MINUTES = 15;
const EXPIRED = 'No print bridge picked this up in time.';

/**
 * The print queue. Screens add jobs; the print bridge at the outlet takes them, prints them and reports back.
 * A failed job is tried again, then sent to the fallback printer, and only then marked as failed.
 */
@Injectable()
export class PrintQueueService {
  private readonly logger = new Logger('PrintQueue');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly printing: PrintingService,
    private readonly realtime: RealtimeService,
  ) {}

  // ── Adding jobs ──

  /**
   * Queues a printout. With `quiet`, returns null when it cannot be printed through a bridge (no printer set up,
   * or the bridge is not connected), so the caller can leave it to the browser's print dialog; without it, says why.
   */
  async queue(restaurantId: string, request: QueueRequest, options: { quiet?: boolean } = {}): Promise<PrintJobDto | null> {
    const route = await this.route(restaurantId, request);
    if (!route) {
      if (options.quiet) return null;
      throw invalid('NO_PRINTER', request.role === 'KOT' ? 'No kitchen printer is set up. Add one under Settings, Printers.' : 'No receipt printer is set up. Add one under Settings, Printers.');
    }
    if (!(await this.printing.bridgeOnline(restaurantId))) {
      if (options.quiet) return null;
      throw conflict('PRINT_BRIDGE_OFFLINE', 'The print bridge is not connected. Check that it is running on the counter computer.');
    }
    const payload: JobPayload = {
      documents: { MM58: request.render(PAPER_COLUMNS.MM58), MM80: request.render(PAPER_COLUMNS.MM80) },
      fallbackPrinterId: route.fallbackId,
    };
    const job = await this.prisma.printJob.create({
      data: {
        restaurantId, printerId: route.printerId, type: request.type, status: 'QUEUED', refType: request.refType, refId: request.refId, title: request.title,
        payload: payload as unknown as Prisma.InputJsonValue, isReprint: request.isReprint ?? false, requestedById: request.requestedById,
      },
      include: jobInclude,
    });
    this.announce(job);
    return this.toDto(job, new Map());
  }

  async testPrint(auth: AuthContext, printerId: string): Promise<PrintJobDto> {
    const printer = await this.prisma.printer.findFirst({ where: { id: printerId, restaurantId: auth.restaurantId } });
    if (!printer) throw notFound('Printer');
    if (printer.connection === 'BROWSER') throw invalid('PRINTER_IS_BROWSER', 'This printer prints through the browser at the counter, so there is nothing to test from here.');
    if (!printer.isActive) throw invalid('PRINTER_UNAVAILABLE', 'Switch this printer on before testing it.');
    const [restaurant, settings] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: auth.restaurantId } }),
      this.prisma.restaurantSettings.findUnique({ where: { restaurantId: auth.restaurantId } }),
    ]);
    const job = await this.queue(auth.restaurantId, {
      type: 'TEST', role: printer.role, refType: 'printer', refId: printer.id, title: 'Test page for ' + printer.name, printerId: printer.id, requestedById: auth.userId,
      render: (columns) => renderTestPage(printer, restaurant.name, columns, settings?.timezone ?? 'Asia/Kolkata'),
    });
    return job!;
  }

  /** Queues a failed job again, as a new job. */
  async retry(auth: AuthContext, id: string): Promise<PrintJobDto> {
    const job = await this.prisma.printJob.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!job) throw notFound('Print job');
    if (job.status !== 'FAILED') throw conflict('PRINT_JOB_NOT_FAILED', 'Only a failed print job can be sent again.');
    if (!auth.permissions.has('settings.manage') && job.requestedById !== auth.userId) throw notFound('Print job');
    const payload = job.payload as unknown as JobPayload;
    const printers = await this.usablePrinters(auth.restaurantId);
    // Back to the printer it was first meant for, if that one is still there.
    const printer = printers.find((entry) => entry.id === job.printerId) ?? printers.find((entry) => entry.id === payload.fallbackPrinterId);
    if (!printer) throw invalid('PRINTER_UNAVAILABLE', 'The printer this was sent to is no longer available.');
    if (!(await this.printing.bridgeOnline(auth.restaurantId))) throw conflict('PRINT_BRIDGE_OFFLINE', 'The print bridge is not connected. Check that it is running on the counter computer.');
    const again = await this.prisma.printJob.create({
      data: {
        restaurantId: auth.restaurantId, printerId: printer.id, type: job.type, status: 'QUEUED', refType: job.refType, refId: job.refId, title: job.title,
        payload: job.payload as Prisma.InputJsonValue, isReprint: true, requestedById: auth.userId,
      },
      include: jobInclude,
    });
    this.announce(again);
    return this.toDto(again, new Map());
  }

  // ── Reading ──

  async list(auth: AuthContext, query: z.output<typeof printJobQuerySchema>): Promise<Page<PrintJobDto>> {
    await this.expire(auth.restaurantId);
    const where: Prisma.PrintJobWhereInput = {
      restaurantId: auth.restaurantId,
      ...(query.status ? { status: query.status } : {}),
      // Everyone sees what they sent to print; the whole queue is for whoever manages the printers.
      ...(query.mine || !auth.permissions.has('settings.manage') ? { requestedById: auth.userId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.printJob.count({ where }),
      this.prisma.printJob.findMany({ where, include: jobInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    const ids = [...new Set(rows.map((row) => row.requestedById).filter((id): id is string => id !== null))];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
    return { items: rows.map((row) => this.toDto(row, names)), total, page: query.page, pageSize: query.pageSize };
  }

  // ── The bridge ──

  /** Hands the bridge the jobs that are waiting, and marks them as being printed. Also how a bridge shows it is alive. */
  async claim(bridge: { id: string; restaurantId: string; lastSeenAt: Date | null }, version: string | undefined): Promise<BridgeJob[]> {
    if (!bridge.lastSeenAt || Date.now() - bridge.lastSeenAt.getTime() > 5_000) {
      await this.prisma.printBridge.update({ where: { id: bridge.id }, data: { lastSeenAt: new Date(), ...(version ? { version } : {}) } });
    }
    await this.expire(bridge.restaurantId);
    // Every time here is this server's, never the database's: the times a job carries were written by this server,
    // and two clocks that differ by a few milliseconds would make a job that was just queued look not yet due.
    const now = new Date();
    const silentSince = new Date(now.getTime() - CLAIM_TIMEOUT_SECONDS * 1000);
    // SKIP LOCKED: two bridges at one outlet never take the same job.
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE print_jobs SET status = 'PRINTING', attempts = attempts + 1, claimed_at = ${now}, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM print_jobs
        WHERE restaurant_id = ${bridge.restaurantId}::uuid AND printer_id IS NOT NULL
          AND ((status = 'QUEUED' AND next_attempt_at <= ${now})
            OR (status = 'PRINTING' AND claimed_at < ${silentSince}))
        ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    if (claimed.length === 0) return [];
    const jobs = await this.prisma.printJob.findMany({ where: { id: { in: claimed.map((row) => row.id) } }, include: { printer: true }, orderBy: { createdAt: 'asc' } });
    const ready: BridgeJob[] = [];
    for (const job of jobs) {
      const printer = job.printer;
      if (!printer || !printer.isActive || printer.connection === 'BROWSER') {
        await this.settle(job.id, 'FAILED', 'The printer this was sent to is switched off or was removed.');
        continue;
      }
      const payload = job.payload as unknown as JobPayload;
      ready.push({
        id: job.id, title: job.title, attempt: job.attempts,
        target: { id: printer.id, name: printer.name, connection: printer.connection, host: printer.host, port: printer.port, devicePath: printer.devicePath },
        document: payload.documents[printer.paperWidth],
      });
    }
    return ready;
  }

  /** The bridge says how a job went. */
  async report(bridge: { restaurantId: string }, jobId: string, result: z.output<typeof bridgeResultSchema>): Promise<void> {
    const job = await this.prisma.printJob.findFirst({ where: { id: jobId, restaurantId: bridge.restaurantId } });
    if (!job) throw notFound('Print job');
    // A late report about a job already settled (or handed out again and finished) changes nothing.
    if (job.status !== 'PRINTING') return;
    const now = new Date();
    if (job.printerId) {
      await this.prisma.printer.updateMany({
        where: { id: job.printerId },
        data: result.ok ? { lastStatus: 'ok', lastError: null, lastSeenAt: now } : { lastStatus: 'error', lastError: result.error ?? 'The printer did not respond.' },
      });
    }
    if (result.ok) {
      await this.settle(job.id, 'DONE', null);
      return;
    }
    const error = result.error ?? 'The printer did not respond.';
    if (job.attempts < MAX_ATTEMPTS) {
      // Wait a little longer each time: a printer that is out of paper or just switched on needs a moment.
      await this.prisma.printJob.update({ where: { id: job.id }, data: { status: 'QUEUED', lastError: error, nextAttemptAt: new Date(now.getTime() + job.attempts * 3_000) } });
      return;
    }
    const payload = job.payload as unknown as JobPayload;
    const fallback = job.fallbackTried || !payload.fallbackPrinterId
      ? null
      : await this.prisma.printer.findFirst({ where: { id: payload.fallbackPrinterId, restaurantId: bridge.restaurantId, isActive: true, connection: { not: 'BROWSER' } } });
    if (fallback) {
      const moved = await this.prisma.printJob.update({
        where: { id: job.id }, data: { status: 'QUEUED', printerId: fallback.id, fallbackTried: true, attempts: 0, lastError: error, nextAttemptAt: now }, include: jobInclude,
      });
      this.announce(moved);
      return;
    }
    await this.settle(job.id, 'FAILED', error);
  }

  // ── Internals ──

  private usablePrinters(restaurantId: string) {
    return this.prisma.printer.findMany({ where: { restaurantId, isActive: true, connection: { not: 'BROWSER' } } });
  }

  /** The printer a job goes to, and the one it moves to if that printer keeps failing. */
  private async route(restaurantId: string, request: QueueRequest): Promise<{ printerId: string; fallbackId: string | null } | null> {
    const printers = await this.usablePrinters(restaurantId);
    const byId = new Map(printers.map((printer) => [printer.id, printer]));
    if (request.printerId) {
      if (!byId.has(request.printerId)) throw invalid('PRINTER_UNAVAILABLE', 'That printer is switched off, or does not print through the bridge.');
      return { printerId: request.printerId, fallbackId: null };
    }
    const usual = printers.find((printer) => printer.role === request.role && printer.isDefault) ?? null;
    if (request.role !== 'KOT') return usual && { printerId: usual.id, fallbackId: null };
    const station = request.stationId ? await this.prisma.kitchenStation.findFirst({ where: { id: request.stationId, restaurantId } }) : null;
    const primary = (station?.printerId ? byId.get(station.printerId) : undefined) ?? usual;
    if (!primary) return null;
    const fallback = [station?.fallbackPrinterId ? byId.get(station.fallbackPrinterId) : undefined, usual].find((printer) => printer && printer.id !== primary.id);
    return { printerId: primary.id, fallbackId: fallback?.id ?? null };
  }

  private async expire(restaurantId: string): Promise<void> {
    const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60_000);
    const stale = await this.prisma.printJob.findMany({ where: { restaurantId, status: { in: ['QUEUED', 'PRINTING'] }, createdAt: { lt: cutoff } }, select: { id: true } });
    for (const job of stale) await this.settle(job.id, 'FAILED', EXPIRED);
  }

  private async settle(id: string, status: 'DONE' | 'FAILED', error: string | null): Promise<void> {
    const job = await this.prisma.printJob.update({
      where: { id }, data: { status, lastError: error, ...(status === 'DONE' ? { printedAt: new Date() } : {}) }, include: jobInclude,
    });
    if (status === 'FAILED') this.logger.warn('Print job failed: ' + job.title + ' (' + (error ?? 'no reason given') + ')');
    this.announce(job);
  }

  private announce(job: JobRow): void {
    this.realtime.emit(job.restaurantId, REALTIME_EVENTS.printJobUpdated, {
      jobId: job.id, status: job.status, type: job.type, title: job.title, requestedById: job.requestedById, error: job.lastError, printerName: job.printer?.name ?? null,
    });
  }

  private toDto(job: JobRow, names: Map<string, string>): PrintJobDto {
    return {
      id: job.id, type: job.type, status: job.status, title: job.title, printerId: job.printerId, printerName: job.printer?.name ?? null, refId: job.refId,
      isReprint: job.isReprint, attempts: job.attempts, lastError: job.lastError, requestedByName: job.requestedById ? (names.get(job.requestedById) ?? null) : null,
      createdAt: job.createdAt.toISOString(), printedAt: job.printedAt?.toISOString() ?? null,
    };
  }
}
