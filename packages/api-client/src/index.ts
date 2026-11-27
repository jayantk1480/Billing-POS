import type { ApiError, PaperWidthKey, PrintDocument, RealtimeEvent } from '@pos/types';
import { io } from 'socket.io-client';
import type {
  AreaDto, AreaInput, CreateTableInput, KotDto, KotQuery, KotStatus, LayoutInput, UpdateTableInput,
  AuthResponse, AuthUser, AmendOrderInput, BulkProductsInput, BulkProductsResult, CancelInvoiceInput, ChangePaymentMethodInput, CategoryDto, CategoryInput, ChangePasswordInput, ClientApp, CreateProductInput, CreateRoleInput,
  AvailableReports, CreateTerminalInput, CreateUserInput, DashboardDto, HealthResponse, ReportData, ReportFormat, ReportQuery, ReportSharing, ReportType, InvoiceDto, InvoiceListItemDto, InvoiceQuery, IssueInvoicesInput,
  CustomerRecordDto, CustomerListItemDto, CustomerLookupDto, CustomerQuery, CustomerSuggestionDto, PosDeviceDto, RegisterDeviceInput,
  ModifierGroupDto, ModifierGroupInput, OrderDto, OrderQuery, OrderSummaryDto, Page, PaymentInput, PermissionDto, PinUser, PosBootstrap,
  ProductDto, ProductQuery, ReasonInput, RefundInput, RenumberResult, RestaurantDto, RoleDto, SaveOrderInput, SessionInfo, SettingsDto, StationDto, StationInput, TaxGroupDto,
  TableDto, TaxGroupInput, TerminalDto, UpdateCategoryInput, UpdateProductInput, UpdateRestaurantInput, UpdateRoleInput,
  UpdateSettingsInput, UpdateStationInput, UpdateTaxGroupInput, UpdateTerminalInput, UpdateUserInput, UploadedImage, UserDto,
  BridgeCreatedDto, BridgeDto, CashMovementInput, CloseRegisterInput, CreateBridgeInput, OpenRegisterInput, PaymentListItemDto, PaymentMethod, PaymentQuery, PrinterDto, PrinterInput,
  PrintingStatusDto, PrintJobDto, PrintJobQuery, PrintLayoutsDto, PrintRequestInput, ReconciliationDto, ReconciliationQuery, ReconciliationRowDto, RegisterDetailDto, RegisterQuery,
  RegisterSessionDto, SaveReconciliationInput, UpdatePrinterInput, UpdatePrintLayoutsInput, OnboardingDto, SignupInput,
  CheckSyncReviewInput, SyncPushInput, SyncPushResponse, SyncReviewDto, SyncReviewQuery,
} from '@pos/validation';

export { createPlatformClient, type PlatformClient } from './platform.js';

/** Thrown for every failed request; `error` is the API's standard error body. */
export class ApiRequestError extends Error {
  constructor(public readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
  }
  get code(): string {
    return this.error.code;
  }
  get status(): number {
    return this.error.statusCode;
  }
  /** Field-level messages from a validation failure, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const details = this.error.details;
    if (!Array.isArray(details)) return {};
    return Object.fromEntries(
      details.flatMap((d: { path?: string; message?: string }) => (d.path && d.message ? [[d.path, d.message]] : [])),
    );
  }
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'locked' }
  /**
   * `offline`: the server could not be reached when the app opened, so this is the user remembered from the last
   * sign-in on this device (only for a client given a `sessionStore`). Requests fail until the server is back;
   * `auth.restore()` then confirms the session, or ends it if it ended meanwhile.
   */
  | { status: 'signedIn'; user: AuthUser; offline?: boolean }
  /** The server could not be reached when the app opened and nobody is remembered on this device. */
  | { status: 'unreachable' };

/**
 * Where an app that keeps working offline remembers who was signed in on this device, so that it can open as that
 * person while the server cannot be reached. Holds the user as the server last described them, never a token.
 */
export interface SessionStore {
  get(): AuthUser | null;
  set(user: AuthUser | null): void;
}

/**
 * Where a native app keeps its refresh token between launches: the device's secure storage.
 * Browsers do not use one; there the token is an HttpOnly cookie the page never sees.
 */
export interface RefreshTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Which front-end app this is; each keeps its own refresh cookie. */
  client: ClientApp;
  /** Give one for a native client ("mobile"): the refresh token is then kept here and sent in a header, and no cookie is used. */
  refreshTokenStore?: RefreshTokenStore;
  /**
   * Give one for an app that keeps working while the server cannot be reached (the POS). Without it, an app that
   * opens with no connection keeps waiting, as before.
   */
  sessionStore?: SessionStore;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function queryString(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Typed client for the REST API. It holds the access token in memory only, and renews it with the
 * HttpOnly refresh cookie when a request is rejected as expired.
 */
export function createApiClient(options: ApiClientOptions) {
  const { baseUrl, client, refreshTokenStore: store, sessionStore } = options;
  let token: string | null = null;
  let state: AuthState = { status: 'loading' };
  let refreshing: Promise<'renewed' | 'network' | 'ended'> | null = null;
  const listeners = new Set<() => void>();

  function setState(next: AuthState): void {
    state = next;
    // Who is signed in is remembered for the next time the app opens offline; anyone signed out or locked is not.
    if (next.status === 'signedIn' && !next.offline) sessionStore?.set(next.user);
    else if (next.status === 'signedOut' || next.status === 'locked') sessionStore?.set(null);
    for (const listener of listeners) listener();
  }

  async function adopt(response: AuthResponse): Promise<AuthUser> {
    // Kept before anyone hears of the sign-in: the token before it stops working the moment this one is used.
    if (store && response.refreshToken) await store.set(response.refreshToken);
    token = response.accessToken;
    setState({ status: 'signedIn', user: response.user });
    return response.user;
  }

  /** A native client's refresh token goes with requests to the auth routes, where a browser's cookie would. */
  async function refreshHeader(path: string): Promise<Record<string, string>> {
    if (!store || !path.startsWith('/auth/')) return {};
    const held = await store.get().catch(() => null);
    return held ? { 'X-Refresh-Token': held } : {};
  }

  async function send(method: string, path: string, body: unknown, withAuth: boolean): Promise<Response> {
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
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      });
    } catch {
      throw new ApiRequestError({ statusCode: 0, code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' });
    }
  }

  async function parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new ApiRequestError(
        (payload as ApiError | null) ?? { statusCode: response.status, code: 'UNKNOWN', message: response.statusText || 'Request failed' },
      );
    }
    return payload as T;
  }

  /** Renews the access token. Concurrent callers share one request. "network" means the server could not be reached. */
  function renew(): Promise<'renewed' | 'network' | 'ended'> {
    refreshing ??= (async () => {
      try {
        await adopt(await parse<AuthResponse>(await send('POST', '/auth/refresh', { client }, false)));
        return 'renewed' as const;
      } catch (error) {
        token = null;
        const locked = error instanceof ApiRequestError && error.code === 'SESSION_LOCKED';
        // A network failure is not a sign-out: keep the current state so the user can retry. For an app that keeps
        // working offline, neither is a server error (a proxy answering 502 while the API is down, say) nor being
        // asked to slow down (every till at an outlet renewing at once when the internet returns).
        const transient = sessionStore && error instanceof ApiRequestError && (error.status >= 500 || error.status === 429);
        if ((error instanceof ApiRequestError && error.code === 'NETWORK') || transient) return 'network' as const;
        // A locked terminal still needs its token, to list who may unlock it; an ended session's token is of no use.
        if (!locked) await store?.clear().catch(() => undefined);
        setState({ status: locked ? 'locked' : 'signedOut' });
        return 'ended' as const;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  const refresh = async (): Promise<boolean> => (await renew()) === 'renewed';

  async function request<T>(method: string, path: string, body?: unknown, withAuth = true): Promise<T> {
    let response = await send(method, path, body, withAuth);
    if (response.status === 401 && withAuth && (await refresh())) {
      response = await send(method, path, body, withAuth);
    }
    return parse<T>(response);
  }

  /** Fetches a file (such as an invoice PDF) with the same sign-in handling as other requests. */
  async function getBlob(path: string): Promise<Blob> {
    let response = await send('GET', path, undefined, true);
    if (response.status === 401 && (await refresh())) response = await send('GET', path, undefined, true);
    if (!response.ok) await parse(response);
    return response.blob();
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', `${path}${queryString(query)}`);
  const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
  const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);
  const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, body);
  const del = (path: string) => request<void>('DELETE', path);

  return {
    health: () => request<HealthResponse>('GET', '/health', undefined, false),

    auth: {
      getState: () => state,
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      /**
       * Call when the app starts: signs in silently if a refresh cookie exists. With a `sessionStore`, a server that
       * cannot be reached opens the app offline as the person remembered on this device, or as `unreachable` when
       * nobody is; call again once the server is back to confirm the session.
       */
      async restore(): Promise<boolean> {
        const outcome = await renew();
        if (outcome === 'network' && sessionStore && (state.status === 'loading' || state.status === 'unreachable')) {
          const remembered = sessionStore.get();
          setState(remembered ? { status: 'signedIn', user: remembered, offline: true } : { status: 'unreachable' });
        }
        return outcome === 'renewed';
      },
      async login(email: string, password: string, terminalId?: string): Promise<AuthUser> {
        return adopt(await request<AuthResponse>('POST', '/auth/login', { email, password, client, terminalId }, false));
      },
      /** Sets which billing terminal this device is. */
      async selectTerminal(terminalId: string): Promise<AuthUser> {
        return adopt(await post<AuthResponse>('/auth/terminal', { client, terminalId }));
      },
      async pinLogin(userId: string, pin: string): Promise<AuthUser> {
        return adopt(await request<AuthResponse>('POST', '/auth/pin-login', { client, userId, pin }, false));
      },
      pinUsers: () => request<PinUser[]>('GET', `/auth/pin-users?client=${client}`, undefined, false),
      async lock(): Promise<void> {
        await post<void>('/auth/lock');
        token = null;
        setState({ status: 'locked' });
      },
      async logout(): Promise<void> {
        try {
          await request<void>('POST', '/auth/logout', { client }, false);
        } finally {
          token = null;
          await store?.clear().catch(() => undefined);
          setState({ status: 'signedOut' });
        }
      },
      me: () => get<AuthUser>('/auth/me'),
      /** Re-reads the signed-in user, for example after the restaurant is renamed or their role changes. */
      async reloadUser(): Promise<void> {
        const user = await get<AuthUser>('/auth/me');
        setState({ status: 'signedIn', user });
      },
      forgotPassword: (email: string) => request<void>('POST', '/auth/forgot-password', { email }, false),
      resetPassword: (resetToken: string, password: string) =>
        request<void>('POST', '/auth/reset-password', { token: resetToken, password }, false),
      changePassword: (input: ChangePasswordInput) => post<void>('/auth/change-password', input),
      sessions: () => get<SessionInfo[]>('/auth/sessions'),
      revokeSession: (id: string) => del(`/auth/sessions/${id}`),
    },

    users: {
      list: () => get<UserDto[]>('/users'),
      create: (input: CreateUserInput) => post<UserDto>('/users', input),
      update: (id: string, input: UpdateUserInput) => patch<UserDto>(`/users/${id}`, input),
    },
    roles: {
      list: () => get<RoleDto[]>('/roles'),
      permissions: () => get<PermissionDto[]>('/permissions'),
      create: (input: CreateRoleInput) => post<RoleDto>('/roles', input),
      update: (id: string, input: UpdateRoleInput) => patch<RoleDto>(`/roles/${id}`, input),
      remove: (id: string) => del(`/roles/${id}`),
    },

    restaurant: {
      get: () => get<RestaurantDto>('/restaurant'),
      update: (input: UpdateRestaurantInput) => patch<RestaurantDto>('/restaurant', input),
    },
    settings: {
      get: () => get<SettingsDto>('/settings'),
      update: (input: UpdateSettingsInput) => patch<SettingsDto>('/settings', input),
    },
    taxGroups: {
      list: () => get<TaxGroupDto[]>('/tax-groups'),
      create: (input: TaxGroupInput) => post<TaxGroupDto>('/tax-groups', input),
      update: (id: string, input: UpdateTaxGroupInput) => patch<TaxGroupDto>(`/tax-groups/${id}`, input),
      remove: (id: string) => del(`/tax-groups/${id}`),
    },
    terminals: {
      list: () => get<TerminalDto[]>('/terminals'),
      create: (input: CreateTerminalInput) => post<TerminalDto>('/terminals', input),
      update: (id: string, input: UpdateTerminalInput) => patch<TerminalDto>(`/terminals/${id}`, input),
    },
    stations: {
      list: () => get<StationDto[]>('/stations'),
      create: (input: StationInput) => post<StationDto>('/stations', input),
      update: (id: string, input: UpdateStationInput) => patch<StationDto>(`/stations/${id}`, input),
      remove: (id: string) => del(`/stations/${id}`),
    },

    categories: {
      list: () => get<CategoryDto[]>('/categories'),
      create: (input: CategoryInput) => post<CategoryDto>('/categories', input),
      update: (id: string, input: UpdateCategoryInput) => patch<CategoryDto>(`/categories/${id}`, input),
      reorder: (ids: string[]) => put<CategoryDto[]>('/categories/order', { ids }),
      remove: (id: string) => del(`/categories/${id}`),
    },
    modifierGroups: {
      list: () => get<ModifierGroupDto[]>('/modifier-groups'),
      create: (input: ModifierGroupInput) => post<ModifierGroupDto>('/modifier-groups', input),
      update: (id: string, input: ModifierGroupInput) => put<ModifierGroupDto>(`/modifier-groups/${id}`, input),
      remove: (id: string) => del(`/modifier-groups/${id}`),
    },
    products: {
      list: (query?: ProductQuery) => get<Page<ProductDto>>('/products', query as Query),
      get: (id: string) => get<ProductDto>(`/products/${id}`),
      create: (input: CreateProductInput) => post<ProductDto>('/products', input),
      update: (id: string, input: UpdateProductInput) => patch<ProductDto>(`/products/${id}`, input),
      setAvailability: (id: string, isAvailable: boolean) => patch<ProductDto>(`/products/${id}/availability`, { isAvailable }),
      remove: (id: string) => del(`/products/${id}`),
      /** Adds many products from spreadsheet rows; with `dryRun` it only reports what would happen. */
      bulkCreate: (input: BulkProductsInput) => post<BulkProductsResult>('/products/bulk', input),
      bulkRemove: (ids: string[]) => post<{ deleted: number }>('/products/bulk-delete', { ids }),
    },
    pos: {
      bootstrap: () => get<PosBootstrap>('/pos/bootstrap'),
      /** Signs this device up for billing offline; the same key always returns the same device. */
      registerDevice: (input: RegisterDeviceInput) => post<PosDeviceDto>('/pos/devices', input),
      tables: () => get<TableDto[]>('/tables'),
    },
    sync: {
      /** Uploads what this device did offline. Each operation is applied once; see SyncResultDto for what came of each. */
      push: (input: SyncPushInput) => post<SyncPushResponse>('/sync/push', input),
      /** Uploads that need a look: stored with flags, or refused. */
      reviews: (query?: SyncReviewQuery) => get<Page<SyncReviewDto>>('/sync/reviews', query as Query),
      check: (id: string, input: CheckSyncReviewInput = {}) => post<SyncReviewDto>(`/sync/reviews/${id}/check`, input),
    },
    customers: {
      list: (query?: CustomerQuery) => get<Page<CustomerListItemDto>>('/customers', query as Query),
      get: (id: string) => get<CustomerRecordDto>(`/customers/${id}`),
      /** The customer a phone number belongs to, or null. */
      lookup: (phone: string) => get<CustomerLookupDto>('/customers/lookup', { phone }),
      /** Customers whose number begins with the digits typed so far. */
      suggest: (phone: string) => get<CustomerSuggestionDto[]>('/customers/suggest', { phone }),
    },
    orders: {
      list: (query?: OrderQuery) => get<Page<OrderSummaryDto>>('/orders', query as Query),
      running: () => get<OrderSummaryDto[]>('/orders/running'),
      get: (id: string) => get<OrderDto>(`/orders/${id}`),
      save: (id: string, input: SaveOrderInput) => put<OrderDto>(`/orders/${id}`, input),
      hold: (id: string) => post<OrderDto>(`/orders/${id}/hold`),
      resume: (id: string) => post<OrderDto>(`/orders/${id}/resume`),
      cancel: (id: string, input: ReasonInput) => post<OrderDto>(`/orders/${id}/cancel`, input),
      /** Deletes the order. A billed order takes its bills and payments with it, which needs invoice.delete. */
      remove: (id: string, input: ReasonInput) => post<RenumberResult>(`/orders/${id}/delete`, input),
      /** Changes the items of a billed order and issues its bill again under the same number. */
      amend: (id: string, input: AmendOrderInput) => post<OrderDto>(`/orders/${id}/amend`, input),
      /** Puts a billed or settled order back into editing; its bills and payments are erased. */
      reopen: (id: string, input: ReasonInput) => post<OrderDto>(`/orders/${id}/reopen`, input),
      merge: (id: string, sourceOrderId: string) => post<OrderDto>(`/orders/${id}/merge`, { sourceOrderId }),
      renumber: () => post<RenumberResult>('/orders/renumber'),
      restartNumbering: () => post<void>('/orders/restart-numbering'),
      issueInvoices: (id: string, input: IssueInvoicesInput = {}) => post<InvoiceDto[]>(`/orders/${id}/invoices`, input),
      /** Sends everything not yet sent to the kitchen and returns the new tickets. */
      sendToKitchen: (id: string) => post<KotDto[]>(`/orders/${id}/kots`),
      transfer: (id: string, tableId: string) => post<OrderDto>(`/orders/${id}/transfer`, { tableId }),
    },
    invoices: {
      list: (query?: InvoiceQuery) => get<Page<InvoiceListItemDto>>('/invoices', query as Query),
      get: (id: string) => get<InvoiceDto>(`/invoices/${id}`),
      pdf: (id: string) => getBlob(`/invoices/${id}/pdf`),
      printed: (id: string) => post<InvoiceDto>(`/invoices/${id}/printed`),
      /** Sends the bill to the receipt printer through the print bridge. */
      print: (id: string, input: PrintRequestInput = {}) => post<PrintJobDto>(`/invoices/${id}/print`, input),
      /** The bill laid out for a printer connected to this device. */
      printDocument: (id: string, width: PaperWidthKey) => get<PrintDocument>(`/invoices/${id}/print-document`, { width }),
      printCreditNote: (id: string, refundId: string, input: PrintRequestInput = {}) => post<PrintJobDto>(`/invoices/${id}/refunds/${refundId}/print`, input),
      pay: (id: string, payments: PaymentInput[]) => post<InvoiceDto>(`/invoices/${id}/payments`, { payments }),
      changePaymentMethod: (id: string, paymentId: string, input: ChangePaymentMethodInput) => patch<InvoiceDto>(`/invoices/${id}/payments/${paymentId}`, input),
      refund: (id: string, input: RefundInput) => post<InvoiceDto>(`/invoices/${id}/refunds`, input),
      cancel: (id: string, input: CancelInvoiceInput) => post<InvoiceDto>(`/invoices/${id}/cancel`, input),
    },
    kots: {
      list: (query?: KotQuery) => get<KotDto[]>('/kots', query as Query),
      setStatus: (id: string, status: KotStatus) => patch<KotDto>(`/kots/${id}/status`, { status }),
      printed: (id: string) => post<KotDto>(`/kots/${id}/printed`),
      /** Sends the ticket to its station printer through the print bridge. */
      print: (id: string, input: PrintRequestInput = {}) => post<PrintJobDto>(`/kots/${id}/print`, input),
      /** The ticket laid out for a printer connected to this device. */
      printDocument: (id: string, width: PaperWidthKey) => get<PrintDocument>(`/kots/${id}/print-document`, { width }),
    },
    registers: {
      list: (query?: RegisterQuery) => get<Page<RegisterSessionDto>>('/registers', query as Query),
      /** The register the signed-in user has open, or null. */
      current: () => get<{ register: RegisterDetailDto | null }>('/registers/current').then((answer) => answer.register),
      get: (id: string) => get<RegisterDetailDto>(`/registers/${id}`),
      open: (input: OpenRegisterInput) => post<RegisterDetailDto>('/registers/open', input),
      move: (input: CashMovementInput) => post<RegisterDetailDto>('/registers/current/movements', input),
      close: (id: string, input: CloseRegisterInput) => post<RegisterDetailDto>(`/registers/${id}/close`, input),
      print: (id: string, input: PrintRequestInput = {}) => post<PrintJobDto>(`/registers/${id}/print`, input),
      /** The register report laid out for a printer connected to this device. */
      printDocument: (id: string, width: PaperWidthKey) => get<PrintDocument>(`/registers/${id}/print-document`, { width }),
    },
    reconciliation: {
      summary: (query: ReconciliationQuery) => get<ReconciliationDto>('/reconciliation', query),
      save: (input: SaveReconciliationInput) => put<ReconciliationRowDto>('/reconciliation', input),
      clear: (businessDate: string, method: PaymentMethod) => del(`/reconciliation/${businessDate}/${method}`),
      payments: (query: PaymentQuery) => get<Page<PaymentListItemDto>>('/payments', query as Query),
    },
    printing: {
      /** Whether bills and kitchen tickets can go through the print bridge right now. */
      status: () => get<PrintingStatusDto>('/printing/status'),
      printers: () => get<PrinterDto[]>('/printers'),
      createPrinter: (input: PrinterInput) => post<PrinterDto>('/printers', input),
      updatePrinter: (id: string, input: UpdatePrinterInput) => patch<PrinterDto>(`/printers/${id}`, input),
      removePrinter: (id: string) => del(`/printers/${id}`),
      test: (id: string) => post<PrintJobDto>(`/printers/${id}/test`),
      layouts: () => get<PrintLayoutsDto>('/print-layouts'),
      updateLayouts: (input: UpdatePrintLayoutsInput) => patch<PrintLayoutsDto>('/print-layouts', input),
      bridges: () => get<BridgeDto[]>('/print-bridges'),
      /** The token in the answer is shown only this once. */
      createBridge: (input: CreateBridgeInput) => post<BridgeCreatedDto>('/print-bridges', input),
      removeBridge: (id: string) => del(`/print-bridges/${id}`),
      jobs: (query?: PrintJobQuery) => get<Page<PrintJobDto>>('/print-jobs', query as Query),
      retry: (id: string) => post<PrintJobDto>(`/print-jobs/${id}/retry`),
    },
    floor: {
      areas: () => get<AreaDto[]>('/areas'),
      createArea: (input: AreaInput) => post<AreaDto>('/areas', input),
      updateArea: (id: string, input: AreaInput) => patch<AreaDto>(`/areas/${id}`, input),
      removeArea: (id: string) => del(`/areas/${id}`),
      createTable: (input: CreateTableInput) => post<TableDto>('/tables', input),
      updateTable: (id: string, input: UpdateTableInput) => patch<TableDto>(`/tables/${id}`, input),
      removeTable: (id: string) => del(`/tables/${id}`),
      saveLayout: (input: LayoutInput) => put<TableDto[]>('/tables/layout', input),
    },
    realtime: {
      /**
       * Opens the live connection. `onEvent` is called with each "something changed" notice;
       * `onStatus` with true or false as the connection comes and goes. Returns a function that closes it.
       */
      connect(onEvent: (event: RealtimeEvent, payload: Record<string, unknown>) => void, onStatus?: (connected: boolean) => void): () => void {
        let closed = false;
        // The token is read afresh on every attempt, so a reconnect after it was renewed just works.
        const socket = io(baseUrl, { auth: (send) => send({ token }), transports: ['websocket'], reconnectionDelayMax: 10_000 });
        socket.onAny((event: string, payload: Record<string, unknown>) => onEvent(event as RealtimeEvent, payload ?? {}));
        socket.on('connect', () => onStatus?.(true));
        socket.on('disconnect', () => onStatus?.(false));
        socket.on('connect_error', (error) => {
          onStatus?.(false);
          // The server turned the token away: renew it once, then try again. Socket.IO does not retry this by itself.
          if (error.message !== 'UNAUTHORIZED' || closed) return;
          void refresh().then((renewed) => {
            if (renewed && !closed) setTimeout(() => socket.connect(), 500);
          });
        });
        return () => {
          closed = true;
          socket.disconnect();
        };
      },
    },
    dashboard: () => get<DashboardDto>('/dashboard'),
    signup: {
      /** Whether restaurants can register themselves, and the length of the free trial. */
      options: () => request<{ enabled: boolean; trialDays: number }>('GET', '/signup/options', undefined, false),
      /** Registers a restaurant. The owner must open the emailed link before signing in. */
      register: (input: SignupInput) => request<void>('POST', '/signup', input, false),
      verify: (verifyToken: string) => request<{ email: string }>('POST', '/signup/verify', { token: verifyToken }, false),
      resend: (email: string) => request<void>('POST', '/signup/resend', { email }, false),
    },
    onboarding: {
      get: () => get<OnboardingDto>('/onboarding'),
      dismiss: () => post<OnboardingDto>('/onboarding/dismiss'),
    },
    reports: {
      /** Which reports the signed-in user may open. */
      available: () => get<AvailableReports>('/reports/available'),
      sharing: () => get<ReportSharing>('/reports/sharing'),
      /** Sets exactly who one report is shared with. */
      share: (type: ReportType, userIds: string[]) => put<ReportSharing>(`/reports/${type}/sharing`, { userIds }),
      run: (type: ReportType, query: ReportQuery) => get<ReportData>(`/reports/${type}`, query),
      /** The report as a file, ready to save. */
      export: (type: ReportType, query: ReportQuery, format: ReportFormat) =>
        getBlob(`/reports/${type}/export${queryString({ ...query, format })}`),
    },
    files: {
      uploadImage(file: File): Promise<UploadedImage> {
        const form = new FormData();
        form.append('file', file);
        return post<UploadedImage>('/files/images', form);
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
