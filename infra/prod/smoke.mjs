/**
 * Checks a running installation from the outside, the way a browser would use it. Needs Node 20 or newer.
 * Run it through smoke.sh, which reads the addresses from .env.
 *
 * Always (safe on a live server; changes nothing):
 *   the API reports healthy, each of the four apps answers, the live-update channel opens, and, when
 *   PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are set, the platform admin can sign in.
 *
 * With MAILPIT_URL set (a rehearsal only: it creates a restaurant):
 *   registers a restaurant, opens the confirmation link from the captured email, signs in, uploads a photo,
 *   adds a product, bills an order and takes payment, then prints what it made as JSON.
 *
 * With SMOKE_CHECK set to that JSON (after a restore, say): signs in as that restaurant again and confirms
 * the bill and the photo are still there.
 */
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value.replace(/\/+$/, '');
};
const API = need('API_URL');
const SITES = { 'back office': need('APP_URL'), 'billing screen': need('POS_URL'), 'kitchen display': need('KDS_URL'), 'platform admin': need('ADMIN_URL') };
// "host:port" to connect to instead of what the address says: for *.localhost names that only browsers resolve.
const CONNECT = process.env.SMOKE_CONNECT || '';

function request(url, { method = 'GET', headers = {}, body, origin, cookie } = {}) {
  const target = new URL(url);
  const [host, port] = CONNECT ? CONNECT.split(':') : [target.hostname, target.port || (target.protocol === 'https:' ? 443 : 80)];
  const payload = body === undefined || Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const options = {
    host, port, method, path: target.pathname + target.search, servername: target.hostname,
    headers: {
      Host: target.host, Accept: 'application/json, text/html',
      ...(payload && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...(payload ? { 'Content-Length': payload.length } : {}),
      ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json, raw, headers: res.headers });
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('no answer within 20 seconds from ' + url)));
    req.on('error', reject);
    req.end(payload);
  });
}

let failures = 0;
async function check(name, run) {
  try {
    const detail = await run();
    console.log('  ok    ' + name + (detail ? '  (' + detail + ')' : ''));
  } catch (error) {
    failures += 1;
    console.log('  FAIL  ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const api = (path, options) => request(API + '/api/v1' + path, options);
const ok = (response, what) => {
  expect(response.status >= 200 && response.status < 300, what + ' answered ' + response.status + ' ' + response.text.slice(0, 200));
  return response;
};
const bearer = (token) => ({ Authorization: 'Bearer ' + token });

console.log('Checking ' + API);
await check('API is healthy, with its database and Redis', async () => {
  const health = ok(await api('/health'), 'health');
  expect(health.json?.status === 'ok', JSON.stringify(health.json));
  return 'version ' + health.json.version;
});
for (const [name, url] of Object.entries(SITES)) {
  await check(name + ' answers at ' + url, async () => {
    const page = await request(url + (name === 'billing screen' || name === 'kitchen display' ? '/' : '/login'));
    expect(page.status === 200 && page.text.includes('<html'), 'answered ' + page.status);
  });
}
await check('live updates can connect through the proxy', async () => {
  const handshake = await request(API + '/socket.io/?EIO=4&transport=polling');
  expect(handshake.status === 200 && handshake.text.includes('"sid"'), 'answered ' + handshake.status + ' ' + handshake.text.slice(0, 80));
});
await check('other sites are refused by the API (CORS)', async () => {
  const stranger = await api('/health', { origin: 'https://not-our-site.example' });
  expect(!stranger.headers['access-control-allow-origin'], 'a stranger origin was allowed');
});

if (process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
  await check('platform admin signs in and sees the restaurants', async () => {
    const origin = SITES['platform admin'];
    const login = ok(await api('/platform/login', { method: 'POST', origin, body: { email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD } }), 'platform sign-in');
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const overview = ok(await api('/platform/overview', { origin, cookie }), 'overview');
    expect((await api('/platform/overview', { origin: SITES['back office'], cookie })).status === 403, 'the admin routes answered a different site');
    await api('/platform/logout', { method: 'POST', origin, cookie });
    return overview.json.restaurants.total + ' restaurant(s)';
  });
}

/** Signs a restaurant user in on one of the apps and returns the access token. */
async function signIn(email, password, client, extra = {}) {
  const origin = client === 'pos' ? SITES['billing screen'] : SITES['back office'];
  const login = ok(await api('/auth/login', { method: 'POST', origin, body: { email, password, client, ...extra } }), client + ' sign-in');
  return { token: login.json.accessToken, origin, user: login.json.user };
}

if (process.env.MAILPIT_URL) {
  const mailpit = process.env.MAILPIT_URL.replace(/\/+$/, '');
  const email = 'smoke-' + Date.now() + '@rehearsal.local';
  const password = 'smoke test password ' + randomUUID().slice(0, 8);
  const made = { email, password };
  await check('a restaurant registers, confirms its email, bills an order and is paid', async () => {
    ok(await api('/signup', {
      method: 'POST', origin: SITES['back office'],
      body: { restaurantName: 'Smoke Test Kitchen', ownerName: 'Smoke Tester', email, password, phone: '9876543210', stateCode: '27', gstRegistration: 'UNREGISTERED' },
    }), 'sign-up');
    // The email is captured by Mailpit instead of being sent.
    let token = '';
    for (let attempt = 0; attempt < 30 && !token; attempt += 1) {
      const list = (await fetch(mailpit + '/api/v1/search?query=' + encodeURIComponent('to:' + email))).json();
      const found = (await list).messages?.[0];
      if (found) token = /token=([\w-]+)/.exec((await (await fetch(mailpit + '/api/v1/message/' + found.ID)).json()).Text)?.[1] ?? '';
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(token, 'no confirmation email arrived in Mailpit');
    ok(await api('/signup/verify', { method: 'POST', body: { token } }), 'confirming the email');

    const office = await signIn(email, password, 'web');
    expect(office.user.restaurantName === 'Smoke Test Kitchen', 'signed in to ' + office.user.restaurantName);
    const headers = bearer(office.token);
    // A 1x1 PNG, uploaded like a product photo.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const boundary = '----smoke' + randomUUID();
    const form = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n'), png, Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const image = ok(await api('/files/images', { method: 'POST', origin: office.origin, headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=' + boundary }, body: form }), 'uploading a photo');
    made.imageUrl = image.json.url;
    expect((await request(made.imageUrl)).raw.equals(png), 'the uploaded photo did not come back the same');

    const category = ok(await api('/categories', { method: 'POST', origin: office.origin, headers, body: { name: 'Mains' } }), 'adding a category').json;
    const product = ok(await api('/products', { method: 'POST', origin: office.origin, headers, body: { name: 'Smoke Thali', categoryId: category.id, basePricePaise: 15000 } }), 'adding a product').json;
    const terminal = ok(await api('/terminals', { origin: office.origin, headers }), 'terminals').json[0];

    const till = await signIn(email, password, 'pos', { terminalId: terminal.id });
    const tillHeaders = bearer(till.token);
    const order = ok(await api('/orders/' + randomUUID(), { method: 'PUT', origin: till.origin, headers: tillHeaders, body: { type: 'TAKEAWAY', items: [{ id: randomUUID(), productId: product.id, quantity: 2 }] } }), 'saving an order').json;
    const [bill] = ok(await api('/orders/' + order.id + '/invoices', { method: 'POST', origin: till.origin, headers: tillHeaders, body: {} }), 'billing').json;
    const paid = ok(await api('/invoices/' + bill.id + '/payments', { method: 'POST', origin: till.origin, headers: tillHeaders, body: { payments: [{ id: randomUUID(), method: 'UPI', amountPaise: bill.totalPaise }] } }), 'taking payment').json;
    expect(paid.paymentStatus === 'PAID', 'the bill is ' + paid.paymentStatus);
    Object.assign(made, { invoiceId: bill.id, invoiceNumber: bill.invoiceNumber, totalPaise: bill.totalPaise });
    return 'bill ' + bill.invoiceNumber + ' for ₹' + bill.totalPaise / 100;
  });
  if (made.invoiceId) console.log('SMOKE_CHECK=' + JSON.stringify(made));
}

if (process.env.SMOKE_CHECK) {
  const made = JSON.parse(process.env.SMOKE_CHECK);
  await check('the restaurant made earlier still has its bill and its photo', async () => {
    const office = await signIn(made.email, made.password, 'web');
    const bill = ok(await api('/invoices/' + made.invoiceId, { origin: office.origin, headers: bearer(office.token) }), 'the bill').json;
    expect(bill.invoiceNumber === made.invoiceNumber && bill.totalPaise === made.totalPaise && bill.paymentStatus === 'PAID', 'the bill came back different: ' + JSON.stringify(bill).slice(0, 200));
    expect((await request(made.imageUrl)).status === 200, 'the photo is gone');
    return 'bill ' + bill.invoiceNumber;
  });
}

console.log(failures === 0 ? 'All checks passed.' : failures + ' check(s) FAILED.');
process.exit(failures === 0 ? 0 : 1);
