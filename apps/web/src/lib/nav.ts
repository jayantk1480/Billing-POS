import type { PermissionKey } from '@pos/types';
import type { AuthUser } from '@pos/validation';
import {
  Armchair, Building2, ClipboardList, CloudOff, Contact, FileBarChart, LayoutDashboard, LayoutGrid, type LucideIcon, MonitorSmartphone, Percent, Printer, ReceiptText, Scale, ShieldCheck, SlidersHorizontal, Soup,
  Users, UtensilsCrossed, Wallet,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: PermissionKey;
  /** Opens the page for someone without the permission, for example when a report was shared with them. */
  alsoFor?: (user: AuthUser) => boolean;
}

/** Whether this person may open the page. */
export const canOpen = (item: NavItem, user: AuthUser | null): boolean =>
  Boolean(user) && (user!.permissions.includes(item.permission) || Boolean(item.alsoFor?.(user!)));

export const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.view' },
      { href: '/reports', label: 'Reports', icon: FileBarChart, permission: 'report.view', alsoFor: (user) => user.sharedReports.length > 0 },
    ],
  },
  {
    title: 'Sales',
    items: [
      { href: '/sales/orders', label: 'Orders', icon: ClipboardList, permission: 'order.view_all' },
      { href: '/sales/invoices', label: 'Bills', icon: ReceiptText, permission: 'order.view_all' },
      { href: '/sales/customers', label: 'Customers', icon: Contact, permission: 'order.view_all' },
      // A cashier without the right to see every register still sees their own.
      { href: '/sales/registers', label: 'Cash registers', icon: Wallet, permission: 'register.view_all', alsoFor: (user) => user.permissions.includes('register.operate') },
      { href: '/sales/reconciliation', label: 'Reconciliation', icon: Scale, permission: 'payment.reconcile' },
      { href: '/sales/offline', label: 'Offline uploads', icon: CloudOff, permission: 'payment.reconcile' },
    ],
  },
  {
    title: 'Menu',
    items: [
      { href: '/menu/products', label: 'Products', icon: UtensilsCrossed, permission: 'menu.view' },
      { href: '/menu/categories', label: 'Categories', icon: LayoutGrid, permission: 'menu.view' },
      { href: '/menu/modifiers', label: 'Modifiers', icon: SlidersHorizontal, permission: 'menu.view' },
    ],
  },
  {
    title: 'Restaurant',
    items: [{ href: '/floor', label: 'Floor', icon: Armchair, permission: 'tables.manage' }],
  },
  {
    title: 'Team',
    items: [
      { href: '/team/users', label: 'Users', icon: Users, permission: 'users.manage' },
      { href: '/team/roles', label: 'Roles', icon: ShieldCheck, permission: 'users.manage' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { href: '/settings/restaurant', label: 'Restaurant', icon: Building2, permission: 'settings.manage' },
      { href: '/settings/billing', label: 'Billing & GST', icon: ReceiptText, permission: 'settings.manage' },
      { href: '/settings/taxes', label: 'Tax groups', icon: Percent, permission: 'settings.manage' },
      { href: '/settings/stations', label: 'Kitchen stations', icon: Soup, permission: 'settings.manage' },
      { href: '/settings/terminals', label: 'Terminals', icon: MonitorSmartphone, permission: 'settings.manage' },
      { href: '/settings/printers', label: 'Printers', icon: Printer, permission: 'settings.manage' },
    ],
  },
];

/** Where a user lands after signing in: the first page their role can open. */
export function homePath(user: AuthUser | null): string {
  return NAV.flatMap((section) => section.items).find((item) => canOpen(item, user))?.href ?? '/account';
}
