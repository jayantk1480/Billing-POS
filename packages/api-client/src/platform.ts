import type { ApiError } from '@pos/types';
import type {
  Page, PlatformAdminDto, PlatformCreateRestaurantInput, PlatformLoginInput, PlatformOverviewDto, PlatformRestaurantDetailDto, PlatformRestaurantDto,
  PlatformRestaurantQuery, SetPaidUntilInput, SetTrialInput,
} from '@pos/validation';
import { ApiRequestError } from './index.js';

/**
 * Client for the platform admin app. It carries no token of its own: the session is an HttpOnly cookie the
 * browser sends to the platform routes only, so nothing a script on the page could read or leak.
 */
export function createPlatformClient(options: { baseUrl: string }) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl}/api/v1/platform${path}`, {
        method,
        credentials: 'include',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiRequestError({ statusCode: 0, code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' });
    }
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new ApiRequestError((payload as ApiError | null) ?? { statusCode: response.status, code: 'UNKNOWN', message: response.statusText || 'Request failed' });
    }
    return payload as T;
  }

  const query = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  return {
    login: (input: PlatformLoginInput) => request<PlatformAdminDto>('POST', '/login', input),
    logout: () => request<void>('POST', '/logout'),
    /** The signed-in admin; fails with status 401 when nobody is signed in. */
    me: () => request<PlatformAdminDto>('GET', '/me'),
    overview: () => request<PlatformOverviewDto>('GET', '/overview'),
    restaurants: {
      list: (params: PlatformRestaurantQuery = {}) => request<Page<PlatformRestaurantDto>>('GET', `/restaurants${query(params as Record<string, string | number | undefined>)}`),
      get: (id: string) => request<PlatformRestaurantDetailDto>('GET', `/restaurants/${id}`),
      create: (input: PlatformCreateRestaurantInput) => request<PlatformRestaurantDetailDto>('POST', '/restaurants', input),
      /** Emails the owner a link to choose a password. */
      invite: (id: string) => request<void>('POST', `/restaurants/${id}/invite`),
      suspend: (id: string, reason: string) => request<PlatformRestaurantDetailDto>('POST', `/restaurants/${id}/suspend`, { reason }),
      reactivate: (id: string) => request<PlatformRestaurantDetailDto>('POST', `/restaurants/${id}/reactivate`),
      setTrial: (id: string, input: SetTrialInput) => request<PlatformRestaurantDetailDto>('PUT', `/restaurants/${id}/trial`, input),
      setPaidUntil: (id: string, input: SetPaidUntilInput) => request<PlatformRestaurantDetailDto>('PUT', `/restaurants/${id}/paid-until`, input),
    },
  };
}

export type PlatformClient = ReturnType<typeof createPlatformClient>;
