import type { ApiError, PaperWidthKey, PrintDocument, RealtimeEvent } from '@pos/types';
import type { AreaDto, AreaInput, CreateTableInput, KotDto, KotQuery, KotStatus, LayoutInput, UpdateTableInput, AuthUser, AmendOrderInput, BulkProductsInput, BulkProductsResult, CancelInvoiceInput, ChangePaymentMethodInput, CategoryDto, CategoryInput, ChangePasswordInput, ClientApp, CreateProductInput, CreateRoleInput, AvailableReports, CreateTerminalInput, CreateUserInput, DashboardDto, ReportData, ReportFormat, ReportQuery, ReportSharing, ReportType, InvoiceDto, InvoiceListItemDto, InvoiceQuery, IssueInvoicesInput, CustomerRecordDto, CustomerListItemDto, CustomerLookupDto, CustomerQuery, CustomerSuggestionDto, PosDeviceDto, RegisterDeviceInput, ModifierGroupDto, ModifierGroupInput, OrderDto, OrderQuery, OrderSummaryDto, Page, PaymentInput, PermissionDto, PinUser, PosBootstrap, ProductDto, ProductQuery, ReasonInput, RefundInput, RenumberResult, RestaurantDto, RoleDto, SaveOrderInput, SessionInfo, SettingsDto, StationDto, StationInput, TaxGroupDto, TableDto, TaxGroupInput, TerminalDto, UpdateCategoryInput, UpdateProductInput, UpdateRestaurantInput, UpdateRoleInput, UpdateSettingsInput, UpdateStationInput, UpdateTaxGroupInput, UpdateTerminalInput, UpdateUserInput, UploadedImage, UserDto, BridgeCreatedDto, BridgeDto, CashMovementInput, CloseRegisterInput, CreateBridgeInput, OpenRegisterInput, PaymentListItemDto, PaymentMethod, PaymentQuery, PrinterDto, PrinterInput, PrintingStatusDto, PrintJobDto, PrintJobQuery, PrintLayoutsDto, PrintRequestInput, ReconciliationDto, ReconciliationQuery, ReconciliationRowDto, RegisterDetailDto, RegisterQuery, RegisterSessionDto, SaveReconciliationInput, UpdatePrinterInput, UpdatePrintLayoutsInput, OnboardingDto, SignupInput, CheckSyncReviewInput, SyncPushInput, SyncPushResponse, SyncReviewDto, SyncReviewQuery } from '@pos/validation';
export { createPlatformClient, type PlatformClient } from './platform.js';
/** Thrown for every failed request; `error` is the API's standard error body. */
export declare class ApiRequestError extends Error {
    readonly error: ApiError;
    constructor(error: ApiError);
    get code(): string;
    get status(): number;
    /** Field-level messages from a validation failure, keyed by field path. */
    get fieldErrors(): Record<string, string>;
}
export type AuthState = {
    status: 'loading';
} | {
    status: 'signedOut';
} | {
    status: 'locked';
}
/**
 * `offline`: the server could not be reached when the app opened, so this is the user remembered from the last
 * sign-in on this device (only for a client given a `sessionStore`). Requests fail until the server is back;
 * `auth.restore()` then confirms the session, or ends it if it ended meanwhile.
 */
 | {
    status: 'signedIn';
    user: AuthUser;
    offline?: boolean;
}
/** The server could not be reached when the app opened and nobody is remembered on this device. */
 | {
    status: 'unreachable';
};
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
/**
 * Typed client for the REST API. It holds the access token in memory only, and renews it with the
 * HttpOnly refresh cookie when a request is rejected as expired.
 */
export declare function createApiClient(options: ApiClientOptions): {
    health: () => Promise<{
        status: "ok" | "degraded";
        version: string;
        database: "up" | "down";
        redis: "up" | "down";
        time: string;
    }>;
    auth: {
        getState: () => AuthState;
        subscribe(listener: () => void): () => void;
        /**
         * Call when the app starts: signs in silently if a refresh cookie exists. With a `sessionStore`, a server that
         * cannot be reached opens the app offline as the person remembered on this device, or as `unreachable` when
         * nobody is; call again once the server is back to confirm the session.
         */
        restore(): Promise<boolean>;
        login(email: string, password: string, terminalId?: string): Promise<AuthUser>;
        /** Sets which billing terminal this device is. */
        selectTerminal(terminalId: string): Promise<AuthUser>;
        pinLogin(userId: string, pin: string): Promise<AuthUser>;
        pinUsers: () => Promise<PinUser[]>;
        lock(): Promise<void>;
        logout(): Promise<void>;
        me: () => Promise<AuthUser>;
        /** Re-reads the signed-in user, for example after the restaurant is renamed or their role changes. */
        reloadUser(): Promise<void>;
        forgotPassword: (email: string) => Promise<void>;
        resetPassword: (resetToken: string, password: string) => Promise<void>;
        changePassword: (input: ChangePasswordInput) => Promise<void>;
        sessions: () => Promise<SessionInfo[]>;
        revokeSession: (id: string) => Promise<void>;
    };
    users: {
        list: () => Promise<UserDto[]>;
        create: (input: CreateUserInput) => Promise<UserDto>;
        update: (id: string, input: UpdateUserInput) => Promise<UserDto>;
    };
    roles: {
        list: () => Promise<RoleDto[]>;
        permissions: () => Promise<PermissionDto[]>;
        create: (input: CreateRoleInput) => Promise<RoleDto>;
        update: (id: string, input: UpdateRoleInput) => Promise<RoleDto>;
        remove: (id: string) => Promise<void>;
    };
    restaurant: {
        get: () => Promise<RestaurantDto>;
        update: (input: UpdateRestaurantInput) => Promise<RestaurantDto>;
    };
    settings: {
        get: () => Promise<SettingsDto>;
        update: (input: UpdateSettingsInput) => Promise<SettingsDto>;
    };
    taxGroups: {
        list: () => Promise<TaxGroupDto[]>;
        create: (input: TaxGroupInput) => Promise<TaxGroupDto>;
        update: (id: string, input: UpdateTaxGroupInput) => Promise<TaxGroupDto>;
        remove: (id: string) => Promise<void>;
    };
    terminals: {
        list: () => Promise<TerminalDto[]>;
        create: (input: CreateTerminalInput) => Promise<TerminalDto>;
        update: (id: string, input: UpdateTerminalInput) => Promise<TerminalDto>;
    };
    stations: {
        list: () => Promise<StationDto[]>;
        create: (input: StationInput) => Promise<StationDto>;
        update: (id: string, input: UpdateStationInput) => Promise<StationDto>;
        remove: (id: string) => Promise<void>;
    };
    categories: {
        list: () => Promise<CategoryDto[]>;
        create: (input: CategoryInput) => Promise<CategoryDto>;
        update: (id: string, input: UpdateCategoryInput) => Promise<CategoryDto>;
        reorder: (ids: string[]) => Promise<CategoryDto[]>;
        remove: (id: string) => Promise<void>;
    };
    modifierGroups: {
        list: () => Promise<ModifierGroupDto[]>;
        create: (input: ModifierGroupInput) => Promise<ModifierGroupDto>;
        update: (id: string, input: ModifierGroupInput) => Promise<ModifierGroupDto>;
        remove: (id: string) => Promise<void>;
    };
    products: {
        list: (query?: ProductQuery) => Promise<Page<ProductDto>>;
        get: (id: string) => Promise<ProductDto>;
        create: (input: CreateProductInput) => Promise<ProductDto>;
        update: (id: string, input: UpdateProductInput) => Promise<ProductDto>;
        setAvailability: (id: string, isAvailable: boolean) => Promise<ProductDto>;
        remove: (id: string) => Promise<void>;
        /** Adds many products from spreadsheet rows; with `dryRun` it only reports what would happen. */
        bulkCreate: (input: BulkProductsInput) => Promise<BulkProductsResult>;
        bulkRemove: (ids: string[]) => Promise<{
            deleted: number;
        }>;
    };
    pos: {
        bootstrap: () => Promise<PosBootstrap>;
        /** Signs this device up for billing offline; the same key always returns the same device. */
        registerDevice: (input: RegisterDeviceInput) => Promise<PosDeviceDto>;
        tables: () => Promise<TableDto[]>;
    };
    sync: {
        /** Uploads what this device did offline. Each operation is applied once; see SyncResultDto for what came of each. */
        push: (input: SyncPushInput) => Promise<SyncPushResponse>;
        /** Uploads that need a look: stored with flags, or refused. */
        reviews: (query?: SyncReviewQuery) => Promise<Page<SyncReviewDto>>;
        check: (id: string, input?: CheckSyncReviewInput) => Promise<SyncReviewDto>;
    };
    customers: {
        list: (query?: CustomerQuery) => Promise<Page<CustomerListItemDto>>;
        get: (id: string) => Promise<CustomerRecordDto>;
        /** The customer a phone number belongs to, or null. */
        lookup: (phone: string) => Promise<CustomerLookupDto>;
        /** Customers whose number begins with the digits typed so far. */
        suggest: (phone: string) => Promise<CustomerSuggestionDto[]>;
    };
    orders: {
        list: (query?: OrderQuery) => Promise<Page<OrderSummaryDto>>;
        running: () => Promise<OrderSummaryDto[]>;
        get: (id: string) => Promise<OrderDto>;
        save: (id: string, input: SaveOrderInput) => Promise<OrderDto>;
        hold: (id: string) => Promise<OrderDto>;
        resume: (id: string) => Promise<OrderDto>;
        cancel: (id: string, input: ReasonInput) => Promise<OrderDto>;
        /** Deletes the order. A billed order takes its bills and payments with it, which needs invoice.delete. */
        remove: (id: string, input: ReasonInput) => Promise<RenumberResult>;
        /** Changes the items of a billed order and issues its bill again under the same number. */
        amend: (id: string, input: AmendOrderInput) => Promise<OrderDto>;
        /** Puts a billed or settled order back into editing; its bills and payments are erased. */
        reopen: (id: string, input: ReasonInput) => Promise<OrderDto>;
        merge: (id: string, sourceOrderId: string) => Promise<OrderDto>;
        renumber: () => Promise<RenumberResult>;
        restartNumbering: () => Promise<void>;
        issueInvoices: (id: string, input?: IssueInvoicesInput) => Promise<InvoiceDto[]>;
        /** Sends everything not yet sent to the kitchen and returns the new tickets. */
        sendToKitchen: (id: string) => Promise<KotDto[]>;
        transfer: (id: string, tableId: string) => Promise<OrderDto>;
    };
    invoices: {
        list: (query?: InvoiceQuery) => Promise<Page<InvoiceListItemDto>>;
        get: (id: string) => Promise<InvoiceDto>;
        pdf: (id: string) => Promise<Blob>;
        printed: (id: string) => Promise<InvoiceDto>;
        /** Sends the bill to the receipt printer through the print bridge. */
        print: (id: string, input?: PrintRequestInput) => Promise<PrintJobDto>;
        /** The bill laid out for a printer connected to this device. */
        printDocument: (id: string, width: PaperWidthKey) => Promise<PrintDocument>;
        printCreditNote: (id: string, refundId: string, input?: PrintRequestInput) => Promise<PrintJobDto>;
        pay: (id: string, payments: PaymentInput[]) => Promise<InvoiceDto>;
        changePaymentMethod: (id: string, paymentId: string, input: ChangePaymentMethodInput) => Promise<InvoiceDto>;
        refund: (id: string, input: RefundInput) => Promise<InvoiceDto>;
        cancel: (id: string, input: CancelInvoiceInput) => Promise<InvoiceDto>;
    };
    kots: {
        list: (query?: KotQuery) => Promise<KotDto[]>;
        setStatus: (id: string, status: KotStatus) => Promise<KotDto>;
        printed: (id: string) => Promise<KotDto>;
        /** Sends the ticket to its station printer through the print bridge. */
        print: (id: string, input?: PrintRequestInput) => Promise<PrintJobDto>;
        /** The ticket laid out for a printer connected to this device. */
        printDocument: (id: string, width: PaperWidthKey) => Promise<PrintDocument>;
    };
    registers: {
        list: (query?: RegisterQuery) => Promise<Page<RegisterSessionDto>>;
        /** The register the signed-in user has open, or null. */
        current: () => Promise<RegisterDetailDto | null>;
        get: (id: string) => Promise<RegisterDetailDto>;
        open: (input: OpenRegisterInput) => Promise<RegisterDetailDto>;
        move: (input: CashMovementInput) => Promise<RegisterDetailDto>;
        close: (id: string, input: CloseRegisterInput) => Promise<RegisterDetailDto>;
        print: (id: string, input?: PrintRequestInput) => Promise<PrintJobDto>;
        /** The register report laid out for a printer connected to this device. */
        printDocument: (id: string, width: PaperWidthKey) => Promise<PrintDocument>;
    };
    reconciliation: {
        summary: (query: ReconciliationQuery) => Promise<ReconciliationDto>;
        save: (input: SaveReconciliationInput) => Promise<ReconciliationRowDto>;
        clear: (businessDate: string, method: PaymentMethod) => Promise<void>;
        payments: (query: PaymentQuery) => Promise<Page<PaymentListItemDto>>;
    };
    printing: {
        /** Whether bills and kitchen tickets can go through the print bridge right now. */
        status: () => Promise<PrintingStatusDto>;
        printers: () => Promise<PrinterDto[]>;
        createPrinter: (input: PrinterInput) => Promise<PrinterDto>;
        updatePrinter: (id: string, input: UpdatePrinterInput) => Promise<PrinterDto>;
        removePrinter: (id: string) => Promise<void>;
        test: (id: string) => Promise<PrintJobDto>;
        layouts: () => Promise<PrintLayoutsDto>;
        updateLayouts: (input: UpdatePrintLayoutsInput) => Promise<PrintLayoutsDto>;
        bridges: () => Promise<BridgeDto[]>;
        /** The token in the answer is shown only this once. */
        createBridge: (input: CreateBridgeInput) => Promise<BridgeCreatedDto>;
        removeBridge: (id: string) => Promise<void>;
        jobs: (query?: PrintJobQuery) => Promise<Page<PrintJobDto>>;
        retry: (id: string) => Promise<PrintJobDto>;
    };
    floor: {
        areas: () => Promise<AreaDto[]>;
        createArea: (input: AreaInput) => Promise<AreaDto>;
        updateArea: (id: string, input: AreaInput) => Promise<AreaDto>;
        removeArea: (id: string) => Promise<void>;
        createTable: (input: CreateTableInput) => Promise<TableDto>;
        updateTable: (id: string, input: UpdateTableInput) => Promise<TableDto>;
        removeTable: (id: string) => Promise<void>;
        saveLayout: (input: LayoutInput) => Promise<TableDto[]>;
    };
    realtime: {
        /**
         * Opens the live connection. `onEvent` is called with each "something changed" notice;
         * `onStatus` with true or false as the connection comes and goes. Returns a function that closes it.
         */
        connect(onEvent: (event: RealtimeEvent, payload: Record<string, unknown>) => void, onStatus?: (connected: boolean) => void): () => void;
    };
    dashboard: () => Promise<DashboardDto>;
    signup: {
        /** Whether restaurants can register themselves, and the length of the free trial. */
        options: () => Promise<{
            enabled: boolean;
            trialDays: number;
        }>;
        /** Registers a restaurant. The owner must open the emailed link before signing in. */
        register: (input: SignupInput) => Promise<void>;
        verify: (verifyToken: string) => Promise<{
            email: string;
        }>;
        resend: (email: string) => Promise<void>;
    };
    onboarding: {
        get: () => Promise<OnboardingDto>;
        dismiss: () => Promise<OnboardingDto>;
    };
    reports: {
        /** Which reports the signed-in user may open. */
        available: () => Promise<AvailableReports>;
        sharing: () => Promise<ReportSharing>;
        /** Sets exactly who one report is shared with. */
        share: (type: ReportType, userIds: string[]) => Promise<ReportSharing>;
        run: (type: ReportType, query: ReportQuery) => Promise<ReportData>;
        /** The report as a file, ready to save. */
        export: (type: ReportType, query: ReportQuery, format: ReportFormat) => Promise<Blob>;
    };
    files: {
        uploadImage(file: File): Promise<UploadedImage>;
    };
};
export type ApiClient = ReturnType<typeof createApiClient>;
//# sourceMappingURL=index.d.ts.map