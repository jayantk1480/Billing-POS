import { ApiRequestError } from './index.js';
/**
 * Client for the platform admin app. It carries no token of its own: the session is an HttpOnly cookie the
 * browser sends to the platform routes only, so nothing a script on the page could read or leak.
 */
export function createPlatformClient(options) {
    async function request(method, path, body) {
        let response;
        try {
            response = await fetch(`${options.baseUrl}/api/v1/platform${path}`, {
                method,
                credentials: 'include',
                headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        }
        catch {
            throw new ApiRequestError({ statusCode: 0, code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' });
        }
        if (response.status === 204)
            return undefined;
        const payload = (await response.json().catch(() => null));
        if (!response.ok) {
            throw new ApiRequestError(payload ?? { statusCode: response.status, code: 'UNKNOWN', message: response.statusText || 'Request failed' });
        }
        return payload;
    }
    const query = (params) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params))
            if (value !== undefined && value !== '')
                search.set(key, String(value));
        const text = search.toString();
        return text ? `?${text}` : '';
    };
    return {
        login: (input) => request('POST', '/login', input),
        logout: () => request('POST', '/logout'),
        /** The signed-in admin; fails with status 401 when nobody is signed in. */
        me: () => request('GET', '/me'),
        overview: () => request('GET', '/overview'),
        restaurants: {
            list: (params = {}) => request('GET', `/restaurants${query(params)}`),
            get: (id) => request('GET', `/restaurants/${id}`),
            create: (input) => request('POST', '/restaurants', input),
            /** Emails the owner a link to choose a password. */
            invite: (id) => request('POST', `/restaurants/${id}/invite`),
            suspend: (id, reason) => request('POST', `/restaurants/${id}/suspend`, { reason }),
            reactivate: (id) => request('POST', `/restaurants/${id}/reactivate`),
            setTrial: (id, input) => request('PUT', `/restaurants/${id}/trial`, input),
            setPaidUntil: (id, input) => request('PUT', `/restaurants/${id}/paid-until`, input),
        },
    };
}
//# sourceMappingURL=platform.js.map