// The POS's service worker. It keeps the app itself (its page, scripts, styles and fonts) on the device, so that the
// POS opens without the internet. It never keeps answers from the API, which has an address of its own, and it
// leaves alone every request it does not recognise.
//
// Registered as /sw.js?v=<build>: each new build is a new worker, which keeps that build's files and drops the last.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'pos-app-' + VERSION;
const PAGE = '/';
/** How long a page load waits for the network before the kept copy is shown instead. */
const PAGE_TIMEOUT_MS = 4000;

/** Paths of the app's built files named in a page: scripts, styles and preloaded fonts. */
const BUILT_FILE = /\/_next\/static\/[^"'`\s\\()<>]+/g;
/** The page's inline data names script chunks without the leading /_next/. */
const CHUNK = /["'`](static\/chunks\/[^"'`\s\\()<>]+)/g;
/** Fonts and images in a style sheet, relative to it. */
const STYLE_URL = /url\(\s*["']?([^"')]+?)["']?\s*\)/g;

function builtFiles(html) {
  const found = new Set();
  for (const [path] of html.matchAll(BUILT_FILE)) found.add(new URL(path, self.location.origin).href);
  for (const [, path] of html.matchAll(CHUNK)) found.add(new URL('/_next/' + path, self.location.origin).href);
  return found;
}

async function fetchOk(url) {
  const response = await fetch(url, { cache: 'reload' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

/** Keeps the page and every file it needs. All or nothing: a half-kept app would not open offline. */
async function keepApp() {
  const page = await fetchOk(PAGE);
  const files = builtFiles(await page.clone().text());
  const kept = new Map();
  for (const url of files) kept.set(url, await fetchOk(url));
  // The style sheets name the fonts.
  for (const [url, response] of [...kept]) {
    if (!new URL(url).pathname.endsWith('.css')) continue;
    for (const [, relative] of (await response.clone().text()).matchAll(STYLE_URL)) {
      if (relative.startsWith('data:')) continue;
      const font = new URL(relative, url);
      if (font.origin === self.location.origin && !kept.has(font.href)) kept.set(font.href, await fetchOk(font.href));
    }
  }
  const cache = await caches.open(CACHE);
  await Promise.all([...kept].map(([url, response]) => cache.put(url, response)));
  await cache.put(PAGE, page);
}

self.addEventListener('install', (event) => {
  event.waitUntil(keepApp().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('pos-app-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/**
 * The page: from the network when it answers in time, and then kept as the newest copy; otherwise the copy kept on
 * the device. Without a kept copy, it is exactly as if there were no service worker.
 */
async function page(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(PAGE);
  const network = fetch(request).then(async (response) => {
    if (response.ok && response.type === 'basic') await cache.put(PAGE, response.clone()).catch(() => undefined);
    return response;
  });
  if (!kept) return network;
  network.catch(() => undefined);
  try {
    const response = await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), PAGE_TIMEOUT_MS)),
    ]);
    // The server itself is down behind its proxy: the kept copy is better than an error page.
    return response.ok ? response : kept;
  } catch {
    return kept;
  }
}

/** A built file: its name changes whenever its content does, so a kept copy is always right. */
async function builtFile(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept) return kept;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone()).catch(() => undefined);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === PAGE) event.respondWith(page(request));
  else if (url.pathname.startsWith('/_next/static/')) event.respondWith(builtFile(request));
});
