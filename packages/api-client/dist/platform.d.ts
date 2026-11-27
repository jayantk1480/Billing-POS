import type { Page, PlatformAdminDto, PlatformCreateRestaurantInput, PlatformLoginInput, PlatformOverviewDto, PlatformRestaurantDetailDto, PlatformRestaurantDto, PlatformRestaurantQuery, SetPaidUntilInput, SetTrialInput } from '@pos/validation';
/**
 * Client for the platform admin app. It carries no token of its own: the session is an HttpOnly cookie the
 * browser sends to the platform routes only, so nothing a script on the page could read or leak.
 */
export declare function createPlatformClient(options: {
    baseUrl: string;
}): {
    login: (input: PlatformLoginInput) => Promise<PlatformAdminDto>;
    logout: () => Promise<void>;
    /** The signed-in admin; fails with status 401 when nobody is signed in. */
    me: () => Promise<PlatformAdminDto>;
    overview: () => Promise<PlatformOverviewDto>;
    restaurants: {
        list: (params?: PlatformRestaurantQuery) => Promise<Page<PlatformRestaurantDto>>;
        get: (id: string) => Promise<PlatformRestaurantDetailDto>;
        create: (input: PlatformCreateRestaurantInput) => Promise<PlatformRestaurantDetailDto>;
        /** Emails the owner a link to choose a password. */
        invite: (id: string) => Promise<void>;
        suspend: (id: string, reason: string) => Promise<PlatformRestaurantDetailDto>;
        reactivate: (id: string) => Promise<PlatformRestaurantDetailDto>;
        setTrial: (id: string, input: SetTrialInput) => Promise<PlatformRestaurantDetailDto>;
        setPaidUntil: (id: string, input: SetPaidUntilInput) => Promise<PlatformRestaurantDetailDto>;
    };
};
export type PlatformClient = ReturnType<typeof createPlatformClient>;
//# sourceMappingURL=platform.d.ts.map