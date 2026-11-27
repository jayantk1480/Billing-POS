export * from './permissions.js';
export * from './events.js';
export * from './states.js';
/** Error shape returned by every API endpoint. */
export interface ApiError {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
}
export * from './printing.js';
//# sourceMappingURL=index.d.ts.map