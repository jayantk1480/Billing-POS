/** Every permission the API checks. Keys are stable; descriptions are shown in the role editor. */
export declare const PERMISSIONS: {
    readonly 'backoffice.access': {
        readonly group: "Access";
        readonly description: "Sign in to the back office (without it, the account works on the billing and kitchen screens only)";
    };
    readonly 'dashboard.view': {
        readonly group: "Dashboard";
        readonly description: "View the sales dashboard";
    };
    readonly 'settings.manage': {
        readonly group: "Settings";
        readonly description: "Change restaurant, tax and printer settings";
    };
    readonly 'users.manage': {
        readonly group: "Users";
        readonly description: "Create and edit users and roles";
    };
    readonly 'menu.view': {
        readonly group: "Menu";
        readonly description: "View the menu";
    };
    readonly 'menu.manage': {
        readonly group: "Menu";
        readonly description: "Create and edit categories, products and modifiers";
    };
    readonly 'menu.availability': {
        readonly group: "Menu";
        readonly description: "Switch items on or off";
    };
    readonly 'tables.manage': {
        readonly group: "Tables";
        readonly description: "Edit areas, tables and the floor layout";
    };
    readonly 'order.create': {
        readonly group: "Orders";
        readonly description: "Create and edit orders";
    };
    readonly 'order.view_all': {
        readonly group: "Orders";
        readonly description: "View order history for all users";
    };
    readonly 'order.cancel': {
        readonly group: "Orders";
        readonly description: "Cancel an order";
    };
    readonly 'order.delete': {
        readonly group: "Orders";
        readonly description: "Delete an unbilled order";
    };
    readonly 'order.renumber': {
        readonly group: "Orders";
        readonly description: "Reset order numbers";
    };
    readonly 'order.transfer': {
        readonly group: "Orders";
        readonly description: "Transfer or merge tables and orders";
    };
    readonly 'discount.apply': {
        readonly group: "Discounts";
        readonly description: "Apply discounts up to the cap";
    };
    readonly 'discount.above_cap': {
        readonly group: "Discounts";
        readonly description: "Apply or approve discounts above the cap";
    };
    readonly 'kot.fire': {
        readonly group: "Kitchen";
        readonly description: "Send items to the kitchen";
    };
    readonly 'kot.cancel_item': {
        readonly group: "Kitchen";
        readonly description: "Cancel an item already sent to the kitchen";
    };
    readonly 'kot.update_status': {
        readonly group: "Kitchen";
        readonly description: "Update ticket status on the kitchen display";
    };
    readonly 'invoice.create': {
        readonly group: "Billing";
        readonly description: "Generate and print bills";
    };
    readonly 'invoice.reprint': {
        readonly group: "Billing";
        readonly description: "Reprint a bill";
    };
    readonly 'invoice.cancel_after_settlement': {
        readonly group: "Billing";
        readonly description: "Cancel a settled bill";
    };
    readonly 'invoice.delete': {
        readonly group: "Billing";
        readonly description: "Permanently delete a billed order with its bills and payments, or reopen it for changes";
    };
    readonly 'payment.record': {
        readonly group: "Payments";
        readonly description: "Record payments";
    };
    readonly 'payment.reconcile': {
        readonly group: "Payments";
        readonly description: "View and reconcile payments";
    };
    readonly 'payment.change_method': {
        readonly group: "Payments";
        readonly description: "Change the payment method of a settled bill";
    };
    readonly 'refund.create': {
        readonly group: "Payments";
        readonly description: "Issue refunds";
    };
    readonly 'register.operate': {
        readonly group: "Cash register";
        readonly description: "Open and close own cash register";
    };
    readonly 'register.adjust': {
        readonly group: "Cash register";
        readonly description: "Add or withdraw cash";
    };
    readonly 'register.view_all': {
        readonly group: "Cash register";
        readonly description: "View all cash register sessions";
    };
    readonly 'report.view': {
        readonly group: "Reports";
        readonly description: "View and export all reports";
    };
    readonly 'report.share': {
        readonly group: "Reports";
        readonly description: "Share individual reports with other users";
    };
    readonly 'audit.view': {
        readonly group: "Reports";
        readonly description: "View the audit log";
    };
};
export type PermissionKey = keyof typeof PERMISSIONS;
export declare const PERMISSION_KEYS: PermissionKey[];
export declare const SYSTEM_ROLES: {
    readonly owner: {
        readonly name: "Owner";
        readonly permissions: ("backoffice.access" | "dashboard.view" | "settings.manage" | "users.manage" | "menu.view" | "menu.manage" | "menu.availability" | "tables.manage" | "order.create" | "order.view_all" | "order.cancel" | "order.delete" | "order.renumber" | "order.transfer" | "discount.apply" | "discount.above_cap" | "kot.fire" | "kot.cancel_item" | "kot.update_status" | "invoice.create" | "invoice.reprint" | "invoice.cancel_after_settlement" | "invoice.delete" | "payment.record" | "payment.reconcile" | "payment.change_method" | "refund.create" | "register.operate" | "register.adjust" | "register.view_all" | "report.view" | "report.share" | "audit.view")[];
    };
    readonly manager: {
        readonly name: "Manager";
        readonly permissions: ("backoffice.access" | "dashboard.view" | "menu.view" | "menu.manage" | "menu.availability" | "tables.manage" | "order.create" | "order.view_all" | "order.cancel" | "order.delete" | "order.renumber" | "order.transfer" | "discount.apply" | "discount.above_cap" | "kot.fire" | "kot.cancel_item" | "kot.update_status" | "invoice.create" | "invoice.reprint" | "invoice.cancel_after_settlement" | "payment.record" | "payment.reconcile" | "payment.change_method" | "refund.create" | "register.operate" | "register.adjust" | "register.view_all" | "report.view" | "report.share" | "audit.view")[];
    };
    readonly cashier: {
        readonly name: "Cashier";
        readonly permissions: readonly ["menu.view", "menu.availability", "order.create", "order.transfer", "discount.apply", "kot.fire", "invoice.create", "invoice.reprint", "payment.record", "register.operate"];
    };
    readonly captain: {
        readonly name: "Captain";
        readonly permissions: readonly ["menu.view", "order.create", "order.transfer", "kot.fire"];
    };
    readonly kitchen: {
        readonly name: "Kitchen";
        readonly permissions: readonly ["menu.view", "menu.availability", "kot.update_status"];
    };
};
export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
//# sourceMappingURL=permissions.d.ts.map