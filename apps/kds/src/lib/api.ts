import { createApiClient } from '@pos/api-client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** The app's single API client. Sign-in state is wired in with the authentication module. */
export const api = createApiClient({ baseUrl: API_URL, client: 'kds' });
