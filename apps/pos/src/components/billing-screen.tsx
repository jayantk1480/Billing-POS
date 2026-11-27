'use client';

import { discountAmount, formatINR } from '@pos/billing-core';
import { ApiRequestError } from '@pos/api-client';
import { Badge, Button, cn, ConfirmDialog, customerLabel, Dialog, ErrorState, errorMessage, formatDateTime, LoadingState, TextField, toast, useApi, useAuth, useRealtime } from '@pos/ui';
import type { InvoiceDto, KotDto, OrderDto, OrderSummaryDto, OrderType, PosBootstrap, TableDto } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, ClipboardList, CookingPot, FileBarChart, Lock, LogOut, Minus, PauseCircle, Percent, Plus, Printer, ReceiptText, ShoppingCart, Split, Trash2, UserRound, UtensilsCrossed, Wallet, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME } from '@/lib/api';
import { ApprovalCancelled, reportError, useApproval } from '@/lib/approval';
import { useBootstrap } from '@/lib/bootstrap';
import { cartBill, type CartLine, toSaveInput, useCart } from '@/lib/cart';
import { CLOCK_TOLERANCE_MS, checkConnection, isUnreachable, useConnection } from '@/lib/connection';
import { useDevice, useDeviceRegistration } from '@/lib/device';
import { billOffline, isMadeOffline, markPrintedOffline, OfflineRefusal, payOffline, sendToKitchenOffline } from '@/lib/offline-billing';
import { useOutbox } from '@/lib/outbox';
import { useLocalPrinter } from '@/lib/local-printer';
import { usePrintKots, usePrintSetup } from '@/lib/printing';
import { CustomerDialog, DiscountDialog, LineDialog, TableDialog } from './cart-dialogs';
import { Catalog } from './catalog';
import { BillsDrawer, OrdersDrawer } from './drawers';
import { PayDialog, SplitDialog } from './payment';
import { ConnectPrinterDialog } from './printer-connect';
import { PrintArea, usePrinter } from './receipt';
import { RegisterDialog, useRegister, useRegisterDialog } from './register';
import { ReportsScreen } from './reports-screen';

/** Asked when items the kitchen already has are being reduced or removed. */
function KitchenCancelDialog({ items, onDone }: { items: string[]; onDone: (reason: string | null) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open onClose={() => onDone(null)} size="sm" title="Already sent to the kitchen"
      description={`${items.join(', ')} ${items.length === 1 ? 'has' : 'have'} been sent. The kitchen will get a cancellation ticket.`}
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={() => onDone(null)}>Keep the items</Button>
          <Button variant="danger" size="touch" disabled={!reason.trim()} onClick={() => onDone(reason.trim())}>Cancel them</Button>
        </>
      }
    >
      <TextField label="Reason for the kitchen" value={reason} onChange={setReason} autoFocus placeholder="Guest changed their mind" />
    </Dialog>
  );
}

const TYPES: { id: OrderType; label: string }[] = [{ id: 'DINE_IN', label: 'Dine-in' }, { id: 'TAKEAWAY', label: 'Takeaway' }, { id: 'DELIVERY', label: 'Delivery' }];
const RESTAURANT_KEY = 'pos.restaurantId';

export function BillingScreen() {
  const { user } = useAuth();
  // Kept on the device, so the POS opens with the menu it last had when the server cannot be reached.
  const boot = useBootstrap(user);
  const online = useConnection((state) => state.online);
  useDeviceRegistration(user?.restaurantId, online === true);

  // A cart left behind by a different restaurant's sign-in on this device must not be billed here.
  useEffect(() => {
    if (!user) return;
    if (window.localStorage.getItem(RESTAURANT_KEY) !== user.restaurantId) {
      useCart.getState().reset();
      window.localStorage.setItem(RESTAURANT_KEY, user.restaurantId);
    }
  }, [user]);

  if (boot.isPending) return <main className="flex min-h-dvh items-center justify-center"><LoadingState label="Loading the menu" /></main>;
  if (boot.isError && !boot.data) {
    return <main className="flex min-h-dvh items-center justify-center"><ErrorState message={errorMessage(boot.error)} onRetry={() => void boot.refetch()} /></main>;
  }
  return <Screen boot={boot.data.boot} savedAt={boot.data.savedAt} offline={online === false} />;
}

/** `savedAt`: when the menu shown was saved on the device, if the server could not be reached for a fresh one. */
function Screen({ boot, savedAt, offline }: { boot: PosBootstrap; savedAt: string | null; offline: boolean }) {
  const api = useApi();
  const { user } = useAuth();
  const approve = useApproval();
  const queryClient = useQueryClient();
  const cart = useCart();
  const { width, setWidth } = usePrinter();
  const printKots = usePrintKots();
  const searchRef = useRef<HTMLInputElement>(null);
  const device = useDevice((state) => state.device);
  const waitingToUpload = useOutbox((state) => state.pending);
  const clock = useConnection((state) => state.clock);
  // Bills and tickets made offline are laid out on this device, the way the restaurant lays them out.
  useEffect(() => usePrintSetup.setState({ layouts: boot.printLayouts, timeZone: boot.settings.timezone }), [boot]);
  /**
   * Whether the order on screen is taken further on this device: the server cannot be reached, or the order was
   * started offline (it is then finished here, and uploaded, even once the connection is back).
   */
  const onDevice = useCallback(() => useConnection.getState().online === false || useCart.getState().offlineOrder !== null, []);
  const clockOffMinutes = clock && Math.abs(clock.offsetMs) > CLOCK_TOLERANCE_MS ? Math.round(Math.abs(clock.offsetMs) / 60_000) : 0;

  // A thermal printer connected to this device itself, through the browser (WebUSB or Web Serial).
  const localPrinter = useLocalPrinter((state) => state.printer);
  const printerSupport = useLocalPrinter((state) => state.supported);
  const [connectPrinter, setConnectPrinter] = useState(false);
  useEffect(() => useLocalPrinter.getState().init(), []);

  const [dialog, setDialog] = useState<'discount' | 'customer' | 'table' | 'split' | 'discard' | null>(null);
  const [drawer, setDrawer] = useState<'orders' | 'bills' | null>(null);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [paying, setPaying] = useState<InvoiceDto[] | null>(null);
  const [busy, setBusy] = useState<'save' | 'hold' | 'bill' | null>(null);
  // Set while the cashier is asked why items already sent to the kitchen are being taken off.
  const [cancelReason, setCancelReason] = useState<{ items: string[]; resolve: (reason: string | null) => void } | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // The user menu gets out of the way as soon as attention goes elsewhere.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);
  const [reportsOpen, setReportsOpen] = useState(false);
  const { allowed: canRegister, register, query: registerQuery } = useRegister();
  const registerDialog = useRegisterDialog();

  const running = useQuery({ queryKey: ['running-orders'], queryFn: api.orders.running, refetchInterval: 30_000 });
  const bill = useMemo(() => cartBill(cart, boot), [cart, boot]);
  const table = boot.tables.find((candidate) => candidate.id === cart.tableId) ?? null;
  const units = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  // What a bill-level discount is measured against: the items after their own discounts.
  const netOfLineDiscounts = cart.lines.reduce((sum, line) => {
    const gross = line.quantity * line.unitPricePaise;
    return sum + gross - discountAmount(gross, line.discount);
  }, 0);
  const taxed = boot.settings.gstRegistration === 'REGULAR';

  // The menu and floor plan come in one large answer. Tables are what changes during service, so it is fetched again
  // for them only where there are tables; a takeaway counter has none.
  const hasTables = boot.tables.length > 0;
  /** Fetches the lists again. A fetch already on its way is left to finish rather than cancelled and sent again. */
  const refetch = useCallback((keys: Iterable<string>) => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false });
  }, [queryClient]);
  const refresh = useCallback(() => {
    refetch(['running-orders', 'bills', 'register', ...(hasTables ? ['pos-bootstrap'] : [])]);
  }, [refetch, hasTables]);

  // Every device at the outlet shares the API's request budget, and one bill sends several notices (order, table,
  // bill, payment). Each notice names what it changes; the lists it touches are fetched once, a moment after the burst.
  const pending = useRef(new Set<string>());
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flush.current) clearTimeout(flush.current);
  }, []);
  const refetchSoon = useCallback((keys: string[]) => {
    for (const key of keys) pending.current.add(key);
    flush.current ??= setTimeout(() => {
      flush.current = null;
      const due = [...pending.current];
      pending.current.clear();
      refetch(due);
    }, 300);
  }, [refetch]);

  // Other terminals and the back office change tables, orders and the menu; pick those changes up as they happen.
  const live = useRealtime((event, payload) => {
    if (event === 'printJob.updated') {
      // Something this cashier sent to a printer did not come out: say so, with the printer's reason.
      if (payload.status === 'FAILED' && payload.requestedById === user?.id) {
        toast.error([String(payload.title ?? 'A printout') + ' did not print' + (payload.printerName ? ' on ' + String(payload.printerName) : '') + '.', payload.error ? String(payload.error) : ''].join(' ').trim(), { duration: 12_000 });
      }
    } else if (event === 'register.updated') refetchSoon(['register']);
    else if (event === 'menu.updated') refetchSoon(['pos-bootstrap']);
    else if (event === 'table.updated') refetchSoon(hasTables ? ['pos-bootstrap'] : []);
    else if (event === 'invoice.updated') refetchSoon(['bills', 'running-orders', 'register']);
    else if (event === 'order.updated' || event === 'order.deleted' || event === 'orders.renumbered') refetchSoon(['running-orders', 'bills']);
  });

  /** Sends the cart to the server, which prices it again and may ask for a manager's approval. */
  const save = useCallback(async () => {
    const current = useCart.getState();
    // From here the order may exist on the server, even if the answer is lost.
    current.markSentToServer();
    const attempt = (kotCancelReason?: string) =>
      approve((approval) => api.orders.save(current.orderId, { ...toSaveInput(current), approval, kotCancelReason }));
    let order;
    try {
      order = await attempt();
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== 'KOT_CANCEL_REASON_REQUIRED') throw error;
      // Something the kitchen is already making was reduced or removed: the kitchen must be told, with a reason.
      const items = (error.error.details as { items?: string[] } | undefined)?.items ?? [];
      const reason = await new Promise<string | null>((resolve) => setCancelReason({ items, resolve }));
      setCancelReason(null);
      if (!reason) throw new ApprovalCancelled();
      order = await attempt(reason);
    }
    useCart.getState().load(order);
    refresh();
    return order;
  }, [api, approve, refresh]);

  /** True when the order can go to the server; otherwise tells the cashier what is missing. */
  const ready = useCallback(() => {
    const current = useCart.getState();
    if (current.lines.length === 0) {
      toast.error('Add at least one item first.');
      return false;
    }
    if (current.type === 'DINE_IN' && !current.tableId) {
      setDialog('table');
      return false;
    }
    return true;
  }, []);

  const run = useCallback(async (kind: 'save' | 'hold' | 'bill', action: () => Promise<void>) => {
    if (busy || !ready()) return;
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      if (isUnreachable(error)) {
        // The connection went while this was on its way: check, so that pressing again carries on offline.
        void checkConnection();
        toast.error('The server cannot be reached. Press again to carry on offline.', { id: 'lost-connection' });
      } else {
        reportError(error);
      }
    } finally {
      setBusy(null);
    }
  }, [busy, ready]);

  /** The KOT button: saves the order, sends whatever is new to the kitchen (one ticket per station), and prints the tickets. */
  const sendToKitchen = useCallback(() => run('save', async () => {
    if (onDevice()) {
      // Without the internet there is no kitchen display: the tickets are always printed.
      const kots = await sendToKitchenOffline(boot, user!);
      const number = useCart.getState().displayNumber;
      if (kots.length === 0) return void toast.success(`Order ${number} kept on this device. Nothing new for the kitchen.`);
      toast.success(`Order ${number} sent to ${kots.map((kot) => kot.stationName ?? 'kitchen').join(' and ')}, from this device`);
      printKots(kots);
      return;
    }
    const order = await save();
    const kots = await api.orders.sendToKitchen(order.id);
    useCart.getState().load(await api.orders.get(order.id));
    if (kots.length === 0) {
      toast.success(`Order ${order.displayNumber} saved. Nothing new for the kitchen.`);
      return;
    }
    toast.success(`Order ${order.displayNumber} sent to ${kots.map((kot) => kot.stationName ?? 'kitchen').join(' and ')}`);
    // A ticket the server already sent to its station printer comes back counted as printed; the rest print here.
    // With KOT printing off, the kitchen works from the kitchen display alone.
    if (boot.settings.autoPrintKot) printKots(kots.filter((kot) => kot.printCount === 0));
  }), [run, save, api, boot, user, onDevice, printKots]);

  const holdOrder = useCallback(() => run('hold', async () => {
    if (onDevice()) throw new OfflineRefusal('Holding an order needs the internet. Send it to the kitchen instead; it stays open on this device.');
    const order = await save();
    await api.orders.hold(order.id);
    useCart.getState().reset(order.type === 'DINE_IN' ? 'TAKEAWAY' : order.type);
    refresh();
    toast.success(`Order ${order.displayNumber} is on hold`);
  }), [run, save, api, refresh, onDevice]);

  /**
   * When the order on screen turns out to be billed already: on this till, by a request whose answer was lost when the
   * connection dropped, or on another terminal. Rather than leave the cashier with an order that refuses every save,
   * take payment for whatever is still due on its bills. Returns false when the order is not billed after all.
   */
  const payWhatIsBilled = useCallback(async (orderId: string): Promise<boolean> => {
    const order = await api.orders.get(orderId).catch(() => null);
    if (!order || (order.status !== 'BILLED' && order.status !== 'SETTLED')) return false;
    const due = order.invoices.filter((invoice) => invoice.status === 'ISSUED' && invoice.paidPaise < invoice.totalPaise);
    useCart.getState().reset(order.type === 'DINE_IN' ? 'TAKEAWAY' : order.type);
    setCartOpen(false);
    refresh();
    if (due.length === 0) {
      toast.success(`Order ${order.displayNumber} is already billed and paid.`);
    } else {
      toast(`Order ${order.displayNumber} was already billed. Take payment for it here.`);
      setPaying(await Promise.all(due.map((invoice) => api.invoices.get(invoice.id))));
    }
    return true;
  }, [api, refresh]);

  const billOrder = useCallback((parts?: { orderItemId: string; quantity: number }[][]) => run('bill', async () => {
    if (onDevice()) {
      if (parts) throw new OfflineRefusal('Splitting a bill needs the internet. Bill it whole, and split the payment instead.');
      const type = useCart.getState().type;
      const invoice = await billOffline(boot, user!, boot.settings.autoPrintReceipt);
      useCart.getState().reset(type);
      setCartOpen(false);
      setPaying([invoice]);
      return;
    }
    // An order that is billed already refuses to be saved. Billing it again with the same bill ids then returns the
    // bills this till issued (the answer to the first request was lost); if they were issued elsewhere, it says so.
    const billed = (error: unknown) => error instanceof ApiRequestError && error.code === 'ORDER_LOCKED';
    let type = useCart.getState().type;
    try {
      type = (await save()).type;
    } catch (error) {
      if (!billed(error)) throw error;
    }
    const { orderId, billIds } = useCart.getState();
    // Bill & pay bills and prints the bill, nothing else: kitchen tickets are made and printed by the KOT button only.
    let invoices: InvoiceDto[];
    try {
      invoices = await api.orders.issueInvoices(orderId, { ...(parts ? { parts } : {}), invoiceIds: billIds.slice(0, parts?.length ?? 1) });
    } catch (error) {
      if (billed(error) && (await payWhatIsBilled(orderId))) return;
      throw error;
    }
    useCart.getState().reset(type === 'DINE_IN' ? 'TAKEAWAY' : type);
    setCartOpen(false);
    refresh();
    setPaying(invoices);
  }), [run, save, api, refresh, payWhatIsBilled, onDevice, boot, user]);

  async function openOrder(id: string) {
    try {
      let order = await api.orders.get(id);
      if (order.status === 'HELD') order = await api.orders.resume(id);
      cart.load(order);
      setDrawer(null);
      refresh();
    } catch (error) {
      reportError(error);
    }
  }

  async function payOrder(order: OrderSummaryDto) {
    try {
      const unpaid = order.invoices.filter((invoice) => invoice.status === 'ISSUED' && invoice.totalPaise > invoice.paidPaise);
      setPaying(await Promise.all(unpaid.map((invoice) => api.invoices.get(invoice.id))));
      setDrawer(null);
    } catch (error) {
      reportError(error);
    }
  }

  async function mergeOrder(source: OrderSummaryDto) {
    try {
      const target = await save();
      cart.load(await api.orders.merge(target.id, source.id));
      refresh();
      toast.success(`Order ${source.displayNumber} merged into ${target.displayNumber}`);
    } catch (error) {
      reportError(error);
    }
  }

  function pickTable(picked: TableDto) {
    // An occupied table already has an order: open it rather than start a second one.
    if (picked.orderId && picked.orderId !== cart.orderId) return void openOrder(picked.orderId);
    cart.setType('DINE_IN');
    cart.setTable(picked.id);
  }

  function chooseType(type: OrderType) {
    if (type === 'DINE_IN' && onDevice()) return void toast.error('Tables need the internet. Take the order as takeaway or delivery to bill it offline.');
    cart.setType(type);
    if (type === 'DINE_IN' && !cart.tableId) setDialog('table');
  }

  const newOrder = () => (cart.dirty && cart.lines.length > 0 ? setDialog('discard') : cart.reset(cart.type === 'DINE_IN' ? 'TAKEAWAY' : cart.type));

  // Keyboard shortcuts for counter billing. They stand down while a dialog is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return;
      const typing = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
      const handlers: Record<string, () => void> = {
        F2: () => searchRef.current?.focus(),
        F4: () => void holdOrder(),
        F6: () => void sendToKitchen(),
        F8: () => void sendToKitchen(),
        F9: () => void billOrder(),
      };
      if (handlers[event.key]) {
        event.preventDefault();
        handlers[event.key]!();
      } else if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [holdOrder, sendToKitchen, billOrder]);

  const onPrinted = useCallback((invoice: InvoiceDto) => {
    // A bill made offline is not on the server yet: the copy kept here notes the printout.
    if (isMadeOffline(invoice.id)) return void markPrintedOffline(invoice).catch(reportError);
    api.invoices.printed(invoice.id).then(refresh, reportError);
  }, [api, refresh]);
  const onKotsPrinted = useCallback((kots: KotDto[]) => {
    for (const kot of kots) if (!isMadeOffline(kot.id)) api.kots.printed(kot.id).catch(reportError);
  }, [api]);

  /** Items already sent to the kitchen from this device offline cannot be cancelled until the connection is back. */
  const changeQuantity = (line: CartLine, quantity: number) => {
    if (cart.offlineOrder && quantity < line.kotQuantity) return void toast.error(`${line.name} was already sent to the kitchen. Cancelling it needs the internet.`);
    cart.setQuantity(line.id, quantity);
  };

  const cartPanel = (
    <div className="flex h-full flex-col bg-surface short:overflow-y-auto">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-base font-semibold text-ink-900">
            {cart.displayNumber ? `Order ${cart.displayNumber}` : 'New order'}
            {/* A saved order that has been edited since: the server does not know about the changes yet. */}
            {cart.saved && cart.dirty && <Badge tone="warn">Unsaved changes</Badge>}
          </p>
          <p className="truncate text-sm text-ink-500">
            {TYPES.find((type) => type.id === cart.type)!.label}
            {table && ` · Table ${table.name}`}
            {cart.customer?.phone && ` · ${customerLabel(cart.customer.phone, cart.customer.name)}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={newOrder} disabled={cart.lines.length === 0 && !cart.saved}>New</Button>
          <button type="button" className="rounded-lg p-2 text-ink-500 hover:bg-canvas lg:hidden" aria-label="Close order" onClick={() => setCartOpen(false)}><X className="size-5" /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto short:flex-none short:overflow-visible">
        {cart.lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-ink-500 short:py-8">
            <ShoppingCart className="size-9 text-ink-300" />
            <p className="mt-3 text-sm">Tap items to add them to the order.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line" aria-label="Order items">
            {cart.lines.map((line) => {
              const amounts = bill.lines.find((entry) => entry.id === line.id);
              const details = [line.variantName, ...line.modifierNames].filter(Boolean).join(' · ');
              return (
                <li key={line.id} className="flex items-center gap-1.5 px-3 py-2.5 sm:gap-2">
                  <button type="button" onClick={() => setEditing(line)} className="min-w-0 flex-1 rounded-lg px-1 py-1 text-left hover:bg-canvas" aria-label={`Edit ${line.name}`}>
                    <span className="line-clamp-2 text-sm font-medium leading-snug text-ink-900">{line.name}</span>
                    {details && <span className="block truncate text-xs text-ink-500">{details}</span>}
                    {line.notes && <span className="block truncate text-xs italic text-amber-700">{line.notes}</span>}
                    <span className="block text-xs tabular-nums text-ink-500">
                      {line.kotQuantity > 0 && (
                        <span className="mr-1.5 rounded bg-green-50 px-1 py-0.5 font-medium text-green-700" title="Already sent to the kitchen">
                          {line.kotQuantity >= line.quantity ? 'Sent' : `${line.kotQuantity} sent`}
                        </span>
                      )}
                      {formatINR(line.unitPricePaise)}
                      {amounts && amounts.discountPaise > 0 && <span className="ml-1.5 text-green-700">− {formatINR(amounts.discountPaise)}</span>}
                    </span>
                  </button>
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label={line.quantity === 1 ? `Remove ${line.name}` : `One less ${line.name}`} onClick={() => changeQuantity(line, line.quantity - 1)} className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line text-ink-700 hover:bg-canvas">
                      {line.quantity === 1 ? <Trash2 className="size-4 text-danger" /> : <Minus className="size-4" />}
                    </button>
                    <span className="w-6 text-center text-base font-semibold tabular-nums sm:w-7" aria-label={`Quantity of ${line.name}`}>{line.quantity}</span>
                    <button type="button" aria-label={`One more ${line.name}`} onClick={() => changeQuantity(line, line.quantity + 1)} className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line text-ink-700 hover:bg-canvas">
                      <Plus className="size-4" />
                    </button>
                  </div>
                  <span className="min-w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-ink-900 sm:w-20">{formatINR((amounts?.grossPaise ?? 0) - (amounts?.discountPaise ?? 0))}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-3">
        <dl className="space-y-1 text-sm" aria-label="Bill totals">
          <div className="flex justify-between"><dt className="text-ink-500">Subtotal ({units} {units === 1 ? 'item' : 'items'})</dt><dd className="tabular-nums">{formatINR(bill.grossPaise)}</dd></div>
          {bill.discountPaise > 0 && <div className="flex justify-between text-green-700"><dt>Discount</dt><dd className="tabular-nums">− {formatINR(bill.discountPaise)}</dd></div>}
          {bill.serviceChargePaise > 0 && <div className="flex justify-between"><dt className="text-ink-500">Service charge</dt><dd className="tabular-nums">{formatINR(bill.serviceChargePaise)}</dd></div>}
          {taxed && <div className="flex justify-between"><dt className="text-ink-500">{bill.taxAddedPaise === 0 && bill.taxPaise > 0 ? 'GST (included)' : 'GST'}</dt><dd className="tabular-nums">{formatINR(bill.taxPaise)}</dd></div>}
          {bill.roundOffPaise !== 0 && <div className="flex justify-between"><dt className="text-ink-500">Round off</dt><dd className="tabular-nums">{formatINR(bill.roundOffPaise)}</dd></div>}
          <div className="flex justify-between border-t border-line pt-2 text-xl font-semibold text-ink-900"><dt>Total</dt><dd className="tabular-nums" data-testid="cart-total">{formatINR(bill.totalPaise)}</dd></div>
        </dl>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button variant="secondary" size="touch" className="px-2! max-[359px]:text-sm" onClick={() => setDialog('discount')} disabled={cart.lines.length === 0}><Percent className="size-4 max-[359px]:hidden" /> Discount</Button>
          <Button variant="secondary" size="touch" className="px-2! max-[359px]:text-sm" onClick={() => setDialog('customer')}><UserRound className="size-4 max-[359px]:hidden" /> Customer</Button>
          <Button variant="secondary" size="touch" className="px-2! max-[359px]:text-sm" onClick={() => ready() && setDialog('split')} disabled={units < 2}><Split className="size-4 max-[359px]:hidden" /> Split</Button>
          <Button variant="secondary" size="touch" className="px-2! max-[359px]:text-sm" onClick={() => void holdOrder()} loading={busy === 'hold'} disabled={cart.lines.length === 0} title="F4"><PauseCircle className="size-4 max-[359px]:hidden" /> Hold</Button>
          <Button variant="secondary" size="touch" className="col-span-2 px-2! max-[359px]:text-sm" onClick={() => void sendToKitchen()} loading={busy === 'save'} disabled={cart.lines.length === 0} title="Send the new items to the kitchen and print the KOT (F6)">
            <CookingPot className="size-4" /> KOT
          </Button>
        </div>
        <Button size="touch" className="mt-2 h-14 w-full text-lg" onClick={() => void billOrder()} loading={busy === 'bill'} disabled={cart.lines.length === 0} title="F9">
          Bill &amp; pay · {formatINR(bill.totalPaise)}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas">
      {boot.restaurant.subscription.status === 'EXPIRED' && (
        <p role="alert" className="shrink-0 bg-amber-100 px-3 py-2 text-center text-sm font-medium text-amber-900">
          The trial or paid period has ended, so orders and bills cannot be made. Ask the owner to renew. Earlier bills can still be opened.
        </p>
      )}
      {(offline || savedAt) && (
        <p role="status" className="shrink-0 bg-red-50 px-3 py-1.5 text-center text-sm font-medium text-red-900">
          {offline ? 'Offline: the server cannot be reached. ' : 'The latest menu could not be loaded. '}
          {savedAt && `Showing the menu saved ${formatDateTime(savedAt)}. `}
          {offline && (device ? 'Takeaway and delivery orders are sent to the kitchen and billed on this device, and uploaded when the connection is back.' : 'This device is not set up for billing offline yet.')}
        </p>
      )}
      {clockOffMinutes > 0 && clock && (
        <p role="alert" className="shrink-0 bg-amber-100 px-3 py-1.5 text-center text-sm font-medium text-amber-900">
          This device&apos;s clock is {clockOffMinutes} minutes {clock.offsetMs > 0 ? 'behind' : 'ahead'}. Set the right time in the device&apos;s settings: bills made without the internet take their time from it.
        </p>
      )}
      {/* One row on a counter screen. Below that, two: who and where on top, the order type underneath.
          A phone held sideways has no height to spare, so it goes back to one row and drops the names. */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 short:h-14 short:flex-nowrap short:py-0 lg:h-14 lg:flex-nowrap lg:py-0">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white"><ChefHat className="size-4.5" /></span>
        <div className="min-w-0 flex-1 short:max-lg:hidden lg:max-w-52 lg:flex-initial">
          <p className="truncate text-sm font-semibold leading-tight text-ink-900">{boot.restaurant.name}</p>
          <p className="truncate text-xs leading-tight text-ink-500">{boot.terminal ? `${boot.terminal.name} · ${boot.terminal.code}` : APP_NAME}</p>
        </div>

        {/* If a long table name leaves no room beside the order types on a narrow phone, the table button drops below them. */}
        <div className="order-last flex w-full flex-wrap items-center gap-2 short:order-none short:w-auto short:flex-nowrap lg:order-none lg:ml-2 lg:w-auto lg:flex-nowrap">
          <div className="flex flex-1 rounded-xl bg-canvas p-1 short:flex-none lg:flex-none" role="radiogroup" aria-label="Order type">
            {TYPES.map((type) => (
              <button
                key={type.id} type="button" role="radio" aria-checked={cart.type === type.id} onClick={() => chooseType(type.id)}
                className={cn('h-10 flex-1 whitespace-nowrap rounded-lg px-1.5 text-[13px] font-semibold sm:px-4 sm:text-sm short:flex-none short:max-lg:px-3 lg:flex-none', cart.type === type.id ? 'bg-surface text-brand-700 shadow-(--shadow-card)' : 'text-ink-700')}
              >
                {type.label}
              </button>
            ))}
          </div>
          {cart.type === 'DINE_IN' && (
            <Button variant="secondary" className="h-12! shrink-0 px-3! short:h-10! lg:h-10! lg:px-4!" onClick={() => setDialog('table')} aria-label={table ? `Table ${table.name}` : 'Choose table'}>
              <UtensilsCrossed className="size-4" />
              <span className="max-w-24 truncate sm:max-w-40">{table ? <><span className="hidden sm:inline">Table </span>{table.name}</> : <><span className="max-[359px]:hidden sm:hidden">Table</span><span className="hidden sm:inline">Choose table</span></>}</span>
            </Button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 short:ml-auto lg:ml-auto">
          {offline ? <Badge tone="danger">Offline</Badge> : <span className="hidden sm:inline"><Badge tone={live ? 'ok' : 'warn'}>{live ? 'Live' : 'Reconnecting'}</Badge></span>}
          {waitingToUpload > 0 && (
            <span title="Orders, bills and payments made offline, waiting to be uploaded" aria-label={`${waitingToUpload} waiting to upload`}><Badge tone="warn">{waitingToUpload} to upload</Badge></span>
          )}
          {/* Only once the server has said so: offline, whether it is open is not known. */}
          {canRegister && boot.settings.registerRequired && registerQuery.isSuccess && !register && (
            <button type="button" onClick={registerDialog.show} className="hidden md:inline" aria-label="Cash register is closed. Open it."><Badge tone="warn">Register closed</Badge></button>
          )}
          {/* Once a printer is connected the button makes way; the user menu keeps connect and disconnect.
              A phone held sideways has no room for it, so there the user menu is the only way in. */}
          {printerSupport.length > 0 && !localPrinter && (
            <Button variant="secondary" className="px-3! sm:px-4! short:hidden!" onClick={() => setConnectPrinter(true)} aria-label="Connect printer" title="Connect a receipt printer">
              <Printer className="size-4" /> <span className="hidden sm:inline">Connect printer</span>
            </Button>
          )}
          <Button variant="secondary" className="px-3! sm:px-4!" onClick={() => setDrawer('orders')} aria-label="Running orders" title="Running orders">
            <ClipboardList className="size-4" /> <span className="hidden sm:inline short:max-lg:hidden!">Running</span>
            {running.data && running.data.length > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-xs text-white">{running.data.length}</span>}
          </Button>
          <Button variant="secondary" className="px-3! sm:px-4!" onClick={() => setDrawer('bills')} aria-label="Today's bills" title="Today's bills"><ReceiptText className="size-4" /> <span className="hidden sm:inline short:max-lg:hidden!">Bills</span></Button>
          <div className="relative" ref={menuRef}>
            <Button variant="ghost" className="px-3! sm:px-4!" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-label="User menu" title="User menu"><UserRound className="size-4" /> <span className="hidden max-w-28 truncate sm:inline short:max-lg:hidden!">{user?.name}</span></Button>
            {menuOpen && (
              <div className="absolute right-0 top-12 z-20 w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-line bg-surface p-2 shadow-xl">
                <p className="px-3 py-2 text-sm text-ink-500">{user?.name} · {user?.role.name}</p>
                {device && (
                  <p className="-mt-1 px-3 pb-2 text-xs text-ink-500" title="Bills made on this device without the internet are numbered in this series">Device code {device.offlineCode}</p>
                )}
                <div className="flex items-center justify-between px-3 py-2 text-sm text-ink-700">
                  Receipt paper
                  <span className="flex rounded-lg bg-canvas p-0.5">
                    {([58, 80] as const).map((size) => (
                      <button key={size} type="button" aria-pressed={width === size} onClick={() => setWidth(size)} className={cn('h-8 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold', width === size ? 'bg-surface text-brand-700 shadow-(--shadow-card)' : 'text-ink-500')}>{size} mm</button>
                    ))}
                  </span>
                </div>
                {/* Always on the menu, even in browsers that cannot connect one: the dialog then says what to use instead. */}
                <button type="button" onClick={() => { setMenuOpen(false); setConnectPrinter(true); }} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-700 hover:bg-canvas">
                  <Printer className="size-4" /> <span className="truncate">{localPrinter ? localPrinter.name : 'Connect printer'}</span>
                  <span className={cn('ml-auto shrink-0 text-xs font-semibold', localPrinter ? 'text-green-700' : 'text-ink-500')}>{localPrinter ? 'Connected' : 'Off'}</span>
                </button>
                {canRegister && (
                  <button type="button" onClick={() => { setMenuOpen(false); registerDialog.show(); }} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-700 hover:bg-canvas">
                    <Wallet className="size-4" /> Cash register
                    <span className={cn('ml-auto text-xs font-semibold', register ? 'text-green-700' : 'text-ink-500')}>{register ? 'Open' : 'Closed'}</span>
                  </button>
                )}
                <button type="button" onClick={() => { setMenuOpen(false); setReportsOpen(true); }} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-700 hover:bg-canvas"><FileBarChart className="size-4" /> Reports</button>
                {/* Both need the server: signed out or locked offline, nobody could sign in again until it is back. */}
                <button type="button" disabled={offline} onClick={() => void api.auth.lock().catch(reportError)} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-700 hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent">
                  <Lock className="size-4" /> Lock terminal{offline && <span className="ml-auto text-xs">Needs the internet</span>}
                </button>
                <button type="button" disabled={offline} onClick={() => void api.auth.logout()} className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink-700 hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent">
                  <LogOut className="size-4" /> Sign out{offline && <span className="ml-auto text-xs">Needs the internet</span>}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Catalog boot={boot} searchRef={searchRef} />
        <aside className="hidden w-96 shrink-0 border-l border-line lg:block" aria-label="Current order">{cartPanel}</aside>
      </div>

      {/* On tablets and phones the order slides over the menu. */}
      <button
        type="button" onClick={() => setCartOpen(true)}
        className="flex h-16 shrink-0 items-center justify-between bg-brand-600 px-5 text-white short:h-12 lg:hidden"
      >
        <span className="flex items-center gap-2 font-semibold"><ShoppingCart className="size-5" /> View order ({units})</span>
        <span className="text-lg font-semibold tabular-nums">{formatINR(bill.totalPaise)}</span>
      </button>
      {cartOpen && (
        <div className="fixed inset-0 z-20 lg:hidden">
          <button type="button" aria-label="Close order" className="absolute inset-0 bg-ink-900/40" onClick={() => setCartOpen(false)} />
          <aside className="absolute inset-y-0 right-0 w-full max-w-md shadow-2xl" aria-label="Current order">{cartPanel}</aside>
        </div>
      )}

      {reportsOpen && <ReportsScreen onClose={() => setReportsOpen(false)} />}
      {dialog === 'discount' && <DiscountDialog discount={cart.discount} base={netOfLineDiscounts} onSave={cart.setDiscount} onClose={() => setDialog(null)} />}
      {dialog === 'customer' && <CustomerDialog customer={cart.customer} onSave={cart.setCustomer} onClose={() => setDialog(null)} />}
      {dialog === 'table' && <TableDialog tables={boot.tables} currentId={cart.tableId} onPick={pickTable} onClose={() => setDialog(null)} />}
      {dialog === 'split' && <SplitDialog lines={cart.lines} onSplit={(parts) => { setDialog(null); void billOrder(parts); }} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'discard'} onClose={() => setDialog(null)} title="Start a new order?" confirmLabel="Discard changes" danger
        message={cart.saved ? 'Changes made since the last save will be lost. The saved order stays under Running orders.' : 'This order has not been saved. Its items will be lost.'}
        onConfirm={() => { cart.reset(cart.type === 'DINE_IN' ? 'TAKEAWAY' : cart.type); setDialog(null); }}
      />
      {editing && (
        <LineDialog
          line={editing} onClose={() => setEditing(null)} onRemove={() => cart.setQuantity(editing.id, 0)}
          onSave={(patch) => cart.updateLine(editing.id, patch)}
        />
      )}
      {drawer === 'orders' && (
        <OrdersDrawer
          currentOrderId={cart.orderId} canMergeInto={cart.lines.length > 0} onClose={() => setDrawer(null)}
          onOpen={(order) => void openOrder(order.id)} onPay={(order) => void payOrder(order)} onMerge={(order) => void mergeOrder(order)}
          onRemoved={(orderId) => { if (orderId === cart.orderId) cart.reset(); }}
        />
      )}
      {drawer === 'bills' && <BillsDrawer businessDate={boot.businessDate} onPay={(invoice) => { setDrawer(null); setPaying([invoice]); }} onClose={() => setDrawer(null)} />}
      {paying && paying.length > 0 && (
        <PayDialog
          invoices={paying} autoPrint={boot.settings.autoPrintReceipt} onFinished={() => { setPaying(null); refresh(); }}
          payOffline={(invoice, payments) => payOffline(boot, user!, invoice, payments)}
        />
      )}
      {registerDialog.open && <RegisterDialog onClose={registerDialog.hide} />}
      {connectPrinter && <ConnectPrinterDialog onClose={() => setConnectPrinter(false)} />}
      <PrintArea onPrinted={onPrinted} onKotsPrinted={onKotsPrinted} />
      {cancelReason && <KitchenCancelDialog items={cancelReason.items} onDone={cancelReason.resolve} />}
    </div>
  );
}
