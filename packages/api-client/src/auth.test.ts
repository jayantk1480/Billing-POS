import type { AuthResponse, AuthUser } from '@pos/validation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type SessionStore } from './index.js';

const user: AuthUser = {
  id: 'u1', name: 'Asha', email: 'asha@test.local', restaurantId: 'r1', restaurantName: 'Spice Route',
  role: { id: 'role1', key: 'cashier', name: 'Cashier' }, permissions: [], sharedReports: [], terminalId: 't1',
};
const signedIn: AuthResponse = { accessToken: 'token-1', expiresIn: 900, user } as AuthResponse;

/** What the server does next: answer with a status and body, or be unreachable. */
type Reply = { status: number; body?: unknown } | 'down';

function server(...replies: Reply[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url.replace('http://api.test/api/v1', ''));
    const reply = replies.shift() ?? 'down';
    if (reply === 'down') throw new TypeError('Failed to fetch');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }));
  return calls;
}

function memoryStore(initial: AuthUser | null = null): SessionStore & { value: AuthUser | null } {
  return {
    value: initial,
    get() { return this.value; },
    set(next) { this.value = next; },
  };
}

const ended = { status: 401, body: { statusCode: 401, code: 'UNAUTHORIZED', message: 'Session ended' } };
const proxyDown = { status: 502, body: { statusCode: 502, code: 'BAD_GATEWAY', message: 'Bad gateway' } };
const slowDown = { status: 429, body: { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' } };

afterEach(() => vi.unstubAllGlobals());

describe('apps that do not keep working offline (no session store)', () => {
  it('keep waiting when the server cannot be reached, and sign out on a server error, as before', async () => {
    server('down');
    const api = createApiClient({ baseUrl: 'http://api.test', client: 'web' });
    expect(await api.auth.restore()).toBe(false);
    expect(api.auth.getState()).toEqual({ status: 'loading' });

    server(proxyDown);
    await api.auth.restore();
    expect(api.auth.getState()).toEqual({ status: 'signedOut' });
  });
});

describe('the POS, which remembers who was signed in on this device', () => {
  it('remembers the signed-in user, never a token, and forgets them on sign-out', async () => {
    const store = memoryStore();
    server({ status: 200, body: signedIn }, { status: 204 });
    const api = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: store });
    await api.auth.login(user.email, 'password');
    expect(store.value).toEqual(user);
    expect(JSON.stringify(store.value)).not.toContain('token-1');
    await api.auth.logout();
    expect(store.value).toBeNull();
  });

  it('opens offline as the remembered user when the server cannot be reached, or as unreachable when nobody is', async () => {
    server('down');
    const remembered = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: memoryStore(user) });
    expect(await remembered.auth.restore()).toBe(false);
    expect(remembered.auth.getState()).toEqual({ status: 'signedIn', user, offline: true });

    server('down');
    const nobody = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: memoryStore() });
    await nobody.auth.restore();
    expect(nobody.auth.getState()).toEqual({ status: 'unreachable' });

    // A proxy answering 502 while the API is down is the same as no connection: nobody is signed out.
    const store = memoryStore(user);
    server(proxyDown);
    const behindProxy = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: store });
    await behindProxy.auth.restore();
    expect(behindProxy.auth.getState()).toEqual({ status: 'signedIn', user, offline: true });
    expect(store.value).toEqual(user);

    // Every till at an outlet renewing at once when the internet returns may be asked to slow down: nobody is signed out.
    server(slowDown);
    const busy = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: store });
    await busy.auth.restore();
    expect(busy.auth.getState()).toEqual({ status: 'signedIn', user, offline: true });
    expect(store.value).toEqual(user);
  });

  it('confirms the session once the server is back, and keeps the remembered user while it is still down', async () => {
    const store = memoryStore(user);
    const calls = server('down', 'down', { status: 200, body: signedIn }, { status: 200, body: [] });
    const api = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: store });
    await api.auth.restore();
    // Still down: nothing changes.
    expect(await api.auth.restore()).toBe(false);
    expect(api.auth.getState()).toEqual({ status: 'signedIn', user, offline: true });
    // Back: the refresh cookie signs the user in properly, and requests carry the new token.
    expect(await api.auth.restore()).toBe(true);
    expect(api.auth.getState()).toEqual({ status: 'signedIn', user });
    await api.auth.sessions();
    expect(calls).toEqual(['/auth/refresh', '/auth/refresh', '/auth/refresh', '/auth/sessions']);
  });

  it('a request made offline that meets a working server renews the session by itself', async () => {
    server('down', ended, { status: 200, body: signedIn }, { status: 200, body: [] });
    const api = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: memoryStore(user) });
    await api.auth.restore();
    // No token yet: the server says 401, the client renews, then repeats the request.
    await expect(api.auth.sessions()).resolves.toEqual([]);
    expect(api.auth.getState()).toEqual({ status: 'signedIn', user });
  });

  it('signs out, and forgets the user, when the session ended while the device was offline', async () => {
    const store = memoryStore(user);
    server('down', ended);
    const api = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: store });
    await api.auth.restore();
    expect(await api.auth.restore()).toBe(false);
    expect(api.auth.getState()).toEqual({ status: 'signedOut' });
    expect(store.value).toBeNull();
  });

  it('forgets the user when the terminal is locked, so a locked device never opens offline as them', async () => {
    const store = memoryStore();
    server({ status: 200, body: signedIn }, { status: 204 });
    const api = createApiClient({ baseUrl: 'http://api.test', client: 'pos', sessionStore: store });
    await api.auth.login(user.email, 'password');
    await api.auth.lock();
    expect(api.auth.getState()).toEqual({ status: 'locked' });
    expect(store.value).toBeNull();
  });
});
