import type { BridgeJob, PrintTarget } from '@pos/types';
import { encode } from './escpos.js';
import { PrintError, type SendLimits, sendToPrinter } from './transport.js';

export interface BridgeOptions {
  /** Where the API is, e.g. https://pos.example.com */
  apiUrl: string;
  /** The token shown once when this bridge was added under Settings, Printers. */
  token: string;
  version: string;
  /** How often to ask for work. */
  pollMs?: number;
  /** Which ports and devices this bridge may print to, beyond the usual ones. */
  limits?: SendLimits;
  send?: (target: PrintTarget, data: Buffer) => Promise<void>;
  log?: (message: string) => void;
}

export interface BridgeState {
  connected: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  printed: number;
  failed: number;
}

/** The API said this bridge is not known: asking again will not help until it is set up again. */
export class NotPairedError extends Error {}

/**
 * The bridge's whole job: ask the API for print jobs, send each to its printer, and say how it went.
 * It never decides anything about retries or fallback printers; the API does, from what is reported here.
 */
export function createBridge(options: BridgeOptions) {
  const { apiUrl, token, version } = options;
  const send = options.send ?? ((target: PrintTarget, data: Buffer) => sendToPrinter(target, data, options.limits));
  const log = options.log ?? (() => undefined);
  const state: BridgeState = { connected: false, lastPollAt: null, lastError: null, printed: 0, failed: 0 };

  async function call(path: string, body: unknown): Promise<Response> {
    return fetch(apiUrl.replace(/\/+$/, '') + '/api/v1/print-bridge' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bridge ' + token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** Told at most a few times: if the API cannot be reached, it hands the job out again by itself after a while. */
  async function report(jobId: string, result: { ok: boolean; error?: string }): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await call('/jobs/' + jobId + '/result', result);
        if (response.ok || response.status === 404) return;
      } catch {
        // Tried again below.
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
    log('Could not tell the server how job ' + jobId + ' went.');
  }

  async function print(job: BridgeJob): Promise<void> {
    try {
      await send(job.target, encode(job.document));
      state.printed += 1;
      log('Printed: ' + job.title + ' on ' + job.target.name);
      await report(job.id, { ok: true });
    } catch (error) {
      state.failed += 1;
      // Only messages written for the counter are passed on; anything else stays in this computer's log.
      const message = error instanceof PrintError ? error.message : 'The print bridge could not print this.';
      log('Failed: ' + job.title + ' on ' + job.target.name + ' (attempt ' + job.attempt + '): ' + (error instanceof Error ? error.message : String(error)));
      await report(job.id, { ok: false, error: message.slice(0, 300) });
    }
  }

  /** Asks for work once and prints what comes back. Returns how many jobs it handled. */
  async function pollOnce(): Promise<number> {
    const response = await call('/claim', { version });
    if (response.status === 401) throw new NotPairedError('The server does not know this print bridge. Add it again under Settings, Printers, and set the new token.');
    if (!response.ok) throw new Error('The server answered ' + response.status);
    const { jobs } = (await response.json()) as { jobs: BridgeJob[] };
    state.connected = true;
    state.lastPollAt = new Date().toISOString();
    state.lastError = null;
    // One printer prints one thing at a time; different printers do not wait for each other.
    const byPrinter = new Map<string, BridgeJob[]>();
    for (const job of jobs) byPrinter.set(job.target.id, [...(byPrinter.get(job.target.id) ?? []), job]);
    await Promise.all([...byPrinter.values()].map(async (queue) => {
      for (const job of queue) await print(job);
    }));
    return jobs.length;
  }

  /** Keeps asking until `signal` is aborted. When the server cannot be reached it waits longer between tries, up to 15 seconds. */
  async function run(signal: AbortSignal): Promise<void> {
    const pollMs = options.pollMs ?? 1_000;
    let wait = pollMs;
    while (!signal.aborted) {
      try {
        const handled = await pollOnce();
        // More may be waiting right behind a full batch.
        wait = handled > 0 ? 0 : pollMs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (state.lastError !== message) log('Not connected: ' + message);
        state.connected = false;
        state.lastError = message;
        wait = error instanceof NotPairedError ? 15_000 : Math.min(Math.max(wait, pollMs) * 2, 15_000);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }

  return { state, pollOnce, run };
}
