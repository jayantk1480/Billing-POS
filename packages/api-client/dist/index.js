import { io } from 'socket.io-client';
export { createPlatformClient } from './platform.js';
/** Thrown for every failed request; `error` is the API's standard error body. */
export class ApiRequestError extends Error {
    error;
    constructor(error) {
        super(error.message);
        this.error = error;
        this.name = 'ApiRequestError';
    }
    get code() {
        return this.error.code;
    }
    get status() {
        return this.error.statusCode;
    }
    /** Field-level messages from a validation failure, keyed by field path. */
    get fieldErrors() {
        const details = this.error.details;
        if (!Array.isArray(details))
            return {};
        return Object.fromEntries(details.flatMap((d) => (d.path && d.message ? [[d.path, d.message]] : [])));
    }
}
function queryString(query) {
    if (!query)
        return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '')
            params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : '';
}
/**
 * Typed client for the REST API. It holds the access token in memory only, and renews it with the
 * HttpOnly refresh cookie when a request is rejected as expired.
 */
export function createApiClient(options) {
    const { baseUrl, client, refreshTokenStore: store, sessionStore } = options;
    let token = null;
    let state = { status: 'loading' };
    let refreshing = null;
    const listeners = new Set();
    function setState(next) {
        state = next;
        // Who is signed in is remembered for the next time the app opens offline; anyone signed out or locked is not.
        if (next.status === 'signedIn' && !next.offline)
            sessionStore?.set(next.user);
        else if (next.status === 'signedOut' || next.status === 'locked')
            sessionStore?.set(null);
        for (const listener of listeners)
            listener();
    }
    async function adopt(response) {
        // Kept before anyone hears of the sign-in: the token before it stops working the moment this one is used.
        if (store && response.refreshToken)
            await store.set(response.refreshToken);
        token = response.accessToken;
        setState({ status: 'signedIn', user: response.user });
        return response.user;
    }
    /** A native client's refresh token goes with requests to the auth routes, where a browser's cookie would. */
    async function refreshHeader(path) {
        if (!store || !path.startsWith('/auth/'))
            return {};
        const held = await store.get().catch(() => null);
        return held ? { 'X-Refresh-Token': held } : {};
    }
    async function send(method, path, body, withAuth) {
        const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
        try {
            return await fetch(`${baseUrl}/api/v1${path}`, {
                method,
                credentials: store ? 'omit' : 'include',
                headers: {
                    ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
                    ...(withAuth && token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(await refreshHeader(path)),
                },
                body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
            });
        }
        catch {
            throw new ApiRequestError({ statusCode: 0, code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' });
        }
    }
    async function parse(response) {
        if (response.status === 204)
            return undefined;
        const payload = (await response.json().catch(() => null));
        if (!response.ok) {
            throw new ApiRequestError(payload ?? { statusCode: response.status, code: 'UNKNOWN', message: response.statusText || 'Request failed' });
        }
        return payload;
    }
    /** Renews the access token. Concurrent callers share one request. "network" means the server could not be reached. */
    function renew() {
        refreshing ??= (async () => {
            try {
                await adopt(await parse(await send('POST', '/auth/refresh', { client }, false)));
                return 'renewed';
            }
            catch (error) {
                token = null;
                const locked = error instanceof ApiRequestError && error.code === 'SESSION_LOCKED';
                // A network failure is not a sign-out: keep the current state so the user can retry. For an app that keeps
                // working offline, neither is a server error (a proxy answering 502 while the API is down, say) nor being
                // asked to slow down (every till at an outlet renewing at once when the internet returns).
                const transient = sessionStore && error instanceof ApiRequestError && (error.status >= 500 || error.status === 429);
                if ((error instanceof ApiRequestError && error.code === 'NETWORK') || transient)
                    return 'network';
                // A locked terminal still needs its token, to list who may unlock it; an ended session's token is of no use.
                if (!locked)
                    await store?.clear().catch(() => undefined);
                setState({ status: locked ? 'locked' : 'signedOut' });
                return 'ended';
            }
            finally {
                refreshing = null;
            }
        })();
        return refreshing;
    }
    const refresh = async () => (await renew()) === 'renewed';
    async function request(method, path, body, withAuth = true) {
        let response = await send(method, path, body, withAuth);
        if (response.status === 401 && withAuth && (await refresh())) {
            response = await send(method, path, body, withAuth);
        }
        return parse(response);
    }
    /** Fetches a file (such as an invoice PDF) with the same sign-in handling as other requests. */
    async function getBlob(path) {
        let response = await send('GET', path, undefined, true);
        if (response.status === 401 && (await refresh()))
            response = await send('GET', path, undefined, true);
        if (!response.ok)
            await parse(response);
        return response.blob();
    }
    const get = (path, query) => request('GET', `${path}${queryString(query)}`);
    const post = (path, body) => request('POST', path, body);
    const patch = (path, body) => request('PATCH', path, body);
    const put = (path, body) => request('PUT', path, body);
    const del = (path) => request('DELETE', path);
    return {
        health: () => request('GET', '/health', undefined, false),
        auth: {
            getState: () => state,
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            /**
             * Call when the app starts: signs in silently if a refresh cookie exists. With a `sessionStore`, a server that
             * cannot be reached opens the app offline as the person remembered on this device, or as `unreachable` when
             * nobody is; call again once the server is back to confirm the session.
             */
            async restore() {
                const outcome = await renew();
                if (outcome === 'network' && sessionStore && (state.status === 'loading' || state.status === 'unreachable')) {
                    const remembered = sessionStore.get();
                    setState(remembered ? { status: 'signedIn', user: remembered, offline: true } : { status: 'unreachable' });
                }
                return outcome === 'renewed';
            },
            async login(email, password, terminalId) {
                return adopt(await request('POST', '/auth/login', { email, password, client, terminalId }, false));
            },
            /** Sets which billing terminal this device is. */
            async selectTerminal(terminalId) {
                return adopt(await post('/auth/terminal', { client, terminalId }));
            },
            async pinLogin(userId, pin) {
                return adopt(await request('POST', '/auth/pin-login', { client, userId, pin }, false));
            },
            pinUsers: () => request('GET', `/auth/pin-users?client=${client}`, undefined, false),
            async lock() {
                await post('/auth/lock');
                token = null;
                setState({ status: 'locked' });
            },
            async logout() {
                try {
                    await request('POST', '/auth/logout', { client }, false);
                }
                finally {
                    token = null;
                    await store?.clear().catch(() => undefined);
                    setState({ status: 'signedOut' });
                }
            },
            me: () => get('/auth/me'),
            /** Re-reads the signed-in user, for example after the restaurant is renamed or their role changes. */
            async reloadUser() {
                const user = await get('/auth/me');
                setState({ status: 'signedIn', user });
            },
            forgotPassword: (email) => request('POST', '/auth/forgot-password', { email }, false),
            resetPassword: (resetToken, password) => request('POST', '/auth/reset-password', { token: resetToken, password }, false),
            changePassword: (input) => post('/auth/change-password', input),
            sessions: () => get('/auth/sessions'),
            revokeSession: (id) => del(`/auth/sessions/${id}`),
        },
        users: {
            list: () => get('/users'),
            create: (input) => post('/users', input),
            update: (id, input) => patch(`/users/${id}`, input),
        },
        roles: {
            list: () => get('/roles'),
            permissions: () => get('/permissions'),
            create: (input) => post('/roles', input),
            update: (id, input) => patch(`/roles/${id}`, input),
            remove: (id) => del(`/roles/${id}`),
        },
        restaurant: {
            get: () => get('/restaurant'),
            update: (input) => patch('/restaurant', input),
        },
        settings: {
            get: () => get('/settings'),
            update: (input) => patch('/settings', input),
        },
        taxGroups: {
            list: () => get('/tax-groups'),
            create: (input) => post('/tax-groups', input),
            update: (id, input) => patch(`/tax-groups/${id}`, input),
            remove: (id) => del(`/tax-groups/${id}`),
        },
        terminals: {
            list: () => get('/terminals'),
            create: (input) => post('/terminals', input),
            update: (id, input) => patch(`/terminals/${id}`, input),
        },
        stations: {
            list: () => get('/stations'),
            create: (input) => post('/stations', input),
            update: (id, input) => patch(`/stations/${id}`, input),
            remove: (id) => del(`/stations/${id}`),
        },
        categories: {
            list: () => get('/categories'),
            create: (input) => post('/categories', input),
            update: (id, input) => patch(`/categories/${id}`, input),
            reorder: (ids) => put('/categories/order', { ids }),
            remove: (id) => del(`/categories/${id}`),
        },
        modifierGroups: {
            list: () => get('/modifier-groups'),
            create: (input) => post('/modifier-groups', input),
            update: (id, input) => put(`/modifier-groups/${id}`, input),
            remove: (id) => del(`/modifier-groups/${id}`),
        },
        products: {
            list: (query) => get('/products', query),
            get: (id) => get(`/products/${id}`),
            create: (input) => post('/products', input),
            update: (id, input) => patch(`/products/${id}`, input),
            setAvailability: (id, isAvailable) => patch(`/products/${id}/availability`, { isAvailable }),
            remove: (id) => del(`/products/${id}`),
            /** Adds many products from spreadsheet rows; with `dryRun` it only reports what would happen. */
            bulkCreate: (input) => post('/products/bulk', input),
            bulkRemove: (ids) => post('/products/bulk-delete', { ids }),
        },
        pos: {
            bootstrap: () => get('/pos/bootstrap'),
            /** Signs this device up for billing offline; the same key always returns the same device. */
            registerDevice: (input) => post('/pos/devices', input),
            tables: () => get('/tables'),
        },
        sync: {
            /** Uploads what this device did offline. Each operation is applied once; see SyncResultDto for what came of each. */
            push: (input) => post('/sync/push', input),
            /** Uploads that need a look: stored with flags, or refused. */
            reviews: (query) => get('/sync/reviews', query),
            check: (id, input = {}) => post(`/sync/reviews/${id}/check`, input),
        },
        customers: {
            list: (query) => get('/customers', query),
            get: (id) => get(`/customers/${id}`),
            /** The customer a phone number belongs to, or null. */
            lookup: (phone) => get('/customers/lookup', { phone }),
            /** Customers whose number begins with the digits typed so far. */
            suggest: (phone) => get('/customers/suggest', { phone }),
        },
        orders: {
            list: (query) => get('/orders', query),
            running: () => get('/orders/running'),
            get: (id) => get(`/orders/${id}`),
            save: (id, input) => put(`/orders/${id}`, input),
            hold: (id) => post(`/orders/${id}/hold`),
            resume: (id) => post(`/orders/${id}/resume`),
            cancel: (id, input) => post(`/orders/${id}/cancel`, input),
            /** Deletes the order. A billed order takes its bills and payments with it, which needs invoice.delete. */
            remove: (id, input) => post(`/orders/${id}/delete`, input),
            /** Changes the items of a billed order and issues its bill again under the same number. */
            amend: (id, input) => post(`/orders/${id}/amend`, input),
            /** Puts a billed or settled order back into editing; its bills and payments are erased. */
            reopen: (id, input) => post(`/orders/${id}/reopen`, input),
            merge: (id, sourceOrderId) => post(`/orders/${id}/merge`, { sourceOrderId }),
            renumber: () => post('/orders/renumber'),
            restartNumbering: () => post('/orders/restart-numbering'),
            issueInvoices: (id, input = {}) => post(`/orders/${id}/invoices`, input),
            /** Sends everything not yet sent to the kitchen and returns the new tickets. */
            sendToKitchen: (id) => post(`/orders/${id}/kots`),
            transfer: (id, tableId) => post(`/orders/${id}/transfer`, { tableId }),
        },
        invoices: {
            list: (query) => get('/invoices', query),
            get: (id) => get(`/invoices/${id}`),
            pdf: (id) => getBlob(`/invoices/${id}/pdf`),
            printed: (id) => post(`/invoices/${id}/printed`),
            /** Sends the bill to the receipt printer through the print bridge. */
            print: (id, input = {}) => post(`/invoices/${id}/print`, input),
            /** The bill laid out for a printer connected to this device. */
            printDocument: (id, width) => get(`/invoices/${id}/print-document`, { width }),
            printCreditNote: (id, refundId, input = {}) => post(`/invoices/${id}/refunds/${refundId}/print`, input),
            pay: (id, payments) => post(`/invoices/${id}/payments`, { payments }),
            changePaymentMethod: (id, paymentId, input) => patch(`/invoices/${id}/payments/${paymentId}`, input),
            refund: (id, input) => post(`/invoices/${id}/refunds`, input),
            cancel: (id, input) => post(`/invoices/${id}/cancel`, input),
        },
        kots: {
            list: (query) => get('/kots', query),
            setStatus: (id, status) => patch(`/kots/${id}/status`, { status }),
            printed: (id) => post(`/kots/${id}/printed`),
            /** Sends the ticket to its station printer through the print bridge. */
            print: (id, input = {}) => post(`/kots/${id}/print`, input),
            /** The ticket laid out for a printer connected to this device. */
            printDocument: (id, width) => get(`/kots/${id}/print-document`, { width }),
        },
        registers: {
            list: (query) => get('/registers', query),
            /** The register the signed-in user has open, or null. */
            current: () => get('/registers/current').then((answer) => answer.register),
            get: (id) => get(`/registers/${id}`),
            open: (input) => post('/registers/open', input),
            move: (input) => post('/registers/current/movements', input),
            close: (id, input) => post(`/registers/${id}/close`, input),
            print: (id, input = {}) => post(`/registers/${id}/print`, input),
            /** The register report laid out for a printer connected to this device. */
            printDocument: (id, width) => get(`/registers/${id}/print-document`, { width }),
        },
        reconciliation: {
            summary: (query) => get('/reconciliation', query),
            save: (input) => put('/reconciliation', input),
            clear: (businessDate, method) => del(`/reconciliation/${businessDate}/${method}`),
            payments: (query) => get('/payments', query),
        },
        printing: {
            /** Whether bills and kitchen tickets can go through the print bridge right now. */
            status: () => get('/printing/status'),
            printers: () => get('/printers'),
            createPrinter: (input) => post('/printers', input),
            updatePrinter: (id, input) => patch(`/printers/${id}`, input),
            removePrinter: (id) => del(`/printers/${id}`),
            test: (id) => post(`/printers/${id}/test`),
            layouts: () => get('/print-layouts'),
            updateLayouts: (input) => patch('/print-layouts', input),
            bridges: () => get('/print-bridges'),
            /** The token in the answer is shown only this once. */
            createBridge: (input) => post('/print-bridges', input),
            removeBridge: (id) => del(`/print-bridges/${id}`),
            jobs: (query) => get('/print-jobs', query),
            retry: (id) => post(`/print-jobs/${id}/retry`),
        },
        floor: {
            areas: () => get('/areas'),
            createArea: (input) => post('/areas', input),
            updateArea: (id, input) => patch(`/areas/${id}`, input),
            removeArea: (id) => del(`/areas/${id}`),
            createTable: (input) => post('/tables', input),
            updateTable: (id, input) => patch(`/tables/${id}`, input),
            removeTable: (id) => del(`/tables/${id}`),
            saveLayout: (input) => put('/tables/layout', input),
        },
        realtime: {
            /**
             * Opens the live connection. `onEvent` is called with each "something changed" notice;
             * `onStatus` with true or false as the connection comes and goes. Returns a function that closes it.
             */
            connect(onEvent, onStatus) {
                let closed = false;
                // The token is read afresh on every attempt, so a reconnect after it was renewed just works.
                const socket = io(baseUrl, { auth: (send) => send({ token }), transports: ['websocket'], reconnectionDelayMax: 10_000 });
                socket.onAny((event, payload) => onEvent(event, payload ?? {}));
                socket.on('connect', () => onStatus?.(true));
                socket.on('disconnect', () => onStatus?.(false));
                socket.on('connect_error', (error) => {
                    onStatus?.(false);
                    // The server turned the token away: renew it once, then try again. Socket.IO does not retry this by itself.
                    if (error.message !== 'UNAUTHORIZED' || closed)
                        return;
                    void refresh().then((renewed) => {
                        if (renewed && !closed)
                            setTimeout(() => socket.connect(), 500);
                    });
                });
                return () => {
                    closed = true;
                    socket.disconnect();
                };
            },
        },
        dashboard: () => get('/dashboard'),
        signup: {
            /** Whether restaurants can register themselves, and the length of the free trial. */
            options: () => request('GET', '/signup/options', undefined, false),
            /** Registers a restaurant. The owner must open the emailed link before signing in. */
            register: (input) => request('POST', '/signup', input, false),
            verify: (verifyToken) => request('POST', '/signup/verify', { token: verifyToken }, false),
            resend: (email) => request('POST', '/signup/resend', { email }, false),
        },
        onboarding: {
            get: () => get('/onboarding'),
            dismiss: () => post('/onboarding/dismiss'),
        },
        reports: {
            /** Which reports the signed-in user may open. */
            available: () => get('/reports/available'),
            sharing: () => get('/reports/sharing'),
            /** Sets exactly who one report is shared with. */
            share: (type, userIds) => put(`/reports/${type}/sharing`, { userIds }),
            run: (type, query) => get(`/reports/${type}`, query),
            /** The report as a file, ready to save. */
            export: (type, query, format) => getBlob(`/reports/${type}/export${queryString({ ...query, format })}`),
        },
        files: {
            uploadImage(file) {
                const form = new FormData();
                form.append('file', file);
                return post('/files/images', form);
            },
        },
    };
}
//# sourceMappingURL=index.js.map