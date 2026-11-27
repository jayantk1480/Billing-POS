/** Names of real-time events sent over the socket; shared by the API and every client. */
export declare const REALTIME_EVENTS: {
    readonly orderUpdated: "order.updated";
    readonly orderDeleted: "order.deleted";
    readonly ordersRenumbered: "orders.renumbered";
    readonly tableUpdated: "table.updated";
    readonly kotCreated: "kot.created";
    readonly kotUpdated: "kot.updated";
    readonly invoiceUpdated: "invoice.updated";
    readonly menuUpdated: "menu.updated";
    readonly printJobUpdated: "printJob.updated";
    readonly registerUpdated: "register.updated";
};
export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];
//# sourceMappingURL=events.d.ts.map