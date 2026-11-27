/** Every permission the API checks. Keys are stable; descriptions are shown in the role editor. */
export const PERMISSIONS = {
  'backoffice.access': { group: 'Access', description: 'Sign in to the back office (without it, the account works on the billing and kitchen screens only)' },
  'dashboard.view': { group: 'Dashboard', description: 'View the sales dashboard' },
  'settings.manage': { group: 'Settings', description: 'Change restaurant, tax and printer settings' },
  'users.manage': { group: 'Users', description: 'Create and edit users and roles' },
  'menu.view': { group: 'Menu', description: 'View the menu' },
  'menu.manage': { group: 'Menu', description: 'Create and edit categories, products and modifiers' },
  'menu.availability': { group: 'Menu', description: 'Switch items on or off' },
  'tables.manage': { group: 'Tables', description: 'Edit areas, tables and the floor layout' },
  'order.create': { group: 'Orders', description: 'Create and edit orders' },
  'order.view_all': { group: 'Orders', description: 'View order history for all users' },
  'order.cancel': { group: 'Orders', description: 'Cancel an order' },
  'order.delete': { group: 'Orders', description: 'Delete an unbilled order' },
  'order.renumber': { group: 'Orders', description: 'Reset order numbers' },
  'order.transfer': { group: 'Orders', description: 'Transfer or merge tables and orders' },
  'discount.apply': { group: 'Discounts', description: 'Apply discounts up to the cap' },
  'discount.above_cap': { group: 'Discounts', description: 'Apply or approve discounts above the cap' },
  'kot.fire': { group: 'Kitchen', description: 'Send items to the kitchen' },
  'kot.cancel_item': { group: 'Kitchen', description: 'Cancel an item already sent to the kitchen' },
  'kot.update_status': { group: 'Kitchen', description: 'Update ticket status on the kitchen display' },
  'invoice.create': { group: 'Billing', description: 'Generate and print bills' },
  'invoice.reprint': { group: 'Billing', description: 'Reprint a bill' },
  'invoice.cancel_after_settlement': { group: 'Billing', description: 'Cancel a settled bill' },
  'invoice.delete': { group: 'Billing', description: 'Permanently delete a billed order with its bills and payments, or reopen it for changes' },
  'payment.record': { group: 'Payments', description: 'Record payments' },
  'payment.reconcile': { group: 'Payments', description: 'View and reconcile payments' },
  'payment.change_method': { group: 'Payments', description: 'Change the payment method of a settled bill' },
  'refund.create': { group: 'Payments', description: 'Issue refunds' },
  'register.operate': { group: 'Cash register', description: 'Open and close own cash register' },
  'register.adjust': { group: 'Cash register', description: 'Add or withdraw cash' },
  'register.view_all': { group: 'Cash register', description: 'View all cash register sessions' },
  'report.view': { group: 'Reports', description: 'View and export all reports' },
  'report.share': { group: 'Reports', description: 'Share individual reports with other users' },
  'audit.view': { group: 'Reports', description: 'View the audit log' },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const SYSTEM_ROLES = {
  owner: { name: 'Owner', permissions: PERMISSION_KEYS },
  manager: {
    name: 'Manager',
    // Erasing a bill is the owner's alone.
    permissions: PERMISSION_KEYS.filter((k) => k !== 'settings.manage' && k !== 'users.manage' && k !== 'invoice.delete'),
  },
  cashier: {
    name: 'Cashier',
    permissions: [
      'menu.view', 'menu.availability', 'order.create', 'order.transfer', 'discount.apply',
      'kot.fire', 'invoice.create', 'invoice.reprint', 'payment.record', 'register.operate',
    ],
  },
  captain: { name: 'Captain', permissions: ['menu.view', 'order.create', 'order.transfer', 'kot.fire'] },
  kitchen: { name: 'Kitchen', permissions: ['menu.view', 'menu.availability', 'kot.update_status'] },
} as const satisfies Record<string, { name: string; permissions: readonly PermissionKey[] }>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
