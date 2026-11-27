import { createApiClient } from '@pos/api-client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'Rasoi POS';
/** Where the billing screen is, for links to it. */
export const POS_URL = process.env.NEXT_PUBLIC_POS_URL ?? 'http://localhost:3101';
/** Shown where a restaurant is told to get in touch about its trial or renewal. Optional. */
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? '';

/** The back office's single API client. */
export const api = createApiClient({ baseUrl: API_URL, client: 'web' });
