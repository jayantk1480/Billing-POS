/**
 * Print bridge: a small service that runs on a computer at the outlet (usually the billing counter PC) and sends
 * bills and kitchen tickets to thermal printers the browser cannot reach.
 *
 * It needs two settings, from the environment or the project's .env file:
 *   PRINT_BRIDGE_API_URL   where the API is (defaults to API_PUBLIC_URL)
 *   PRINT_BRIDGE_TOKEN     the token shown once when the bridge is added under Settings, Printers
 *
 * It prints only to network ports 9100 to 9109 and to the usual printer devices. For a printer on anything else:
 *   PRINT_BRIDGE_ALLOW_PORTS     extra ports, comma separated, e.g. 6001,515
 *   PRINT_BRIDGE_ALLOW_DEVICES   extra device paths, comma separated
 */
import { createServer } from 'node:http';
import path from 'node:path';
import { createBridge } from './bridge.js';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // Variables are provided by the environment.
}

const VERSION = '1.0.0';
const PORT = Number(process.env.PRINT_BRIDGE_PORT ?? 9110);
const API_URL = process.env.PRINT_BRIDGE_API_URL ?? process.env.API_PUBLIC_URL ?? '';
const TOKEN = process.env.PRINT_BRIDGE_TOKEN ?? '';
const ALLOWED_ORIGINS = new Set([process.env.POS_URL, process.env.WEB_URL].filter(Boolean));
const list = (value: string | undefined) => (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
const LIMITS = {
  extraPorts: list(process.env.PRINT_BRIDGE_ALLOW_PORTS).map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65_536),
  extraDevices: list(process.env.PRINT_BRIDGE_ALLOW_DEVICES),
};

const log = (message: string) => console.log(new Date().toISOString().slice(11, 19) + ' ' + message);
const paired = Boolean(API_URL && TOKEN);
const bridge = paired ? createBridge({ apiUrl: API_URL, token: TOKEN, version: VERSION, log, limits: LIMITS }) : null;

// A status page for whoever is setting the bridge up. It prints nothing and accepts nothing.
const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'print-bridge', version: VERSION, paired, ...(bridge?.state ?? {}) }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ statusCode: 404, code: 'NOT_FOUND', message: 'Not found' }));
});

// Bound to loopback only: the bridge must never be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  log('Print bridge ' + VERSION + ' status page on http://127.0.0.1:' + PORT + '/health');
  if (!bridge) {
    log('Not set up yet. In the back office open Settings, Printers, add a print bridge, and put its token in PRINT_BRIDGE_TOKEN.');
    return;
  }
  log('Asking ' + API_URL + ' for print jobs.');
});

const stop = new AbortController();
if (bridge) void bridge.run(stop.signal);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop.abort();
    server.close();
  });
}
