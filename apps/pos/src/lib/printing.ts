'use client';

import { ApiRequestError } from '@pos/api-client';
import { renderKot, renderReceipt } from '@pos/printing';
import { PAPER_COLUMNS } from '@pos/types';
import { toast, useApi } from '@pos/ui';
import type { InvoiceDto, KotDto, PrintingStatusDto, PrintLayoutsDto } from '@pos/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { create } from 'zustand';
import { usePrinter } from '@/components/receipt';
import { reportError } from './approval';
import { useLocalPrinter } from './local-printer';
import { isMadeOffline, markPrintedOffline } from './offline-billing';

/** How this restaurant lays out bills and tickets, from the bootstrap: for printing on the device without the server. */
export const usePrintSetup = create<{ layouts: PrintLayoutsDto | null; timeZone: string }>(() => ({ layouts: null, timeZone: 'Asia/Kolkata' }));

const STATUS_KEY = ['printing-status'];
/** The bridge cannot print this right now; the browser's print dialog can. */
const USE_BROWSER = new Set(['PRINT_BRIDGE_OFFLINE', 'NO_PRINTER']);

/** The paper width chosen in the user menu, as the API names it. */
const widthKey = () => (usePrinter.getState().width === 58 ? 'MM58' as const : 'MM80' as const);

/** Whether the outlet's receipt printer can be reached through the print bridge at this moment. */
function useBridgeStatus(): () => Promise<PrintingStatusDto | null> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useCallback(
    // Asked for when something is about to print, and remembered for a few seconds so a run of prints asks once.
    () => queryClient.fetchQuery({ queryKey: STATUS_KEY, queryFn: api.printing.status, staleTime: 5_000 }).catch(() => null),
    [api, queryClient],
  );
}

/**
 * Prints a bill. A printer connected to this device itself comes first; then the outlet's receipt
 * printer through the print bridge; and failing both, the browser's print dialog opens, as it
 * does on a counter without any printer set up.
 */
export function usePrintBill(): (invoice: InvoiceDto) => void {
  const api = useApi();
  const queryClient = useQueryClient();
  const status = useBridgeStatus();
  const browserPrint = usePrinter((printer) => printer.print);

  return useCallback((invoice: InvoiceDto) => {
    void (async () => {
      // A bill made on this device offline is laid out here: the server may not have it yet.
      if (isMadeOffline(invoice.id)) {
        const local = useLocalPrinter.getState();
        const { layouts, timeZone } = usePrintSetup.getState();
        if (local.printer && layouts) {
          try {
            await local.print(renderReceipt(invoice, layouts.receipt, PAPER_COLUMNS[widthKey()], timeZone));
            await markPrintedOffline(invoice);
            toast.success('Bill ' + invoice.invoiceNumber + ' printed');
            return;
          } catch (error) {
            toast.error('Could not print on ' + local.printer.name + '. ' + (error instanceof Error ? error.message : ''), { duration: 10_000 });
          }
        }
        return browserPrint(invoice);
      }
      const printed = () => {
        void queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
        void queryClient.invalidateQueries({ queryKey: ['bills'] });
      };

      const local = useLocalPrinter.getState();
      if (local.printer) {
        try {
          const document = await api.invoices.printDocument(invoice.id, widthKey());
          await local.print(document);
          await api.invoices.printed(invoice.id);
          toast.success('Bill ' + invoice.invoiceNumber + ' printed');
          printed();
          return;
        } catch (error) {
          // The server said no (for example, no permission to reprint): that stands.
          if (error instanceof ApiRequestError) return reportError(error);
          // The printer itself failed: say why, and let the browser's dialog save the bill.
          toast.error('Could not print on ' + local.printer.name + '. ' + (error instanceof Error ? error.message : ''), { duration: 10_000 });
        }
      }

      const now = await status();
      if (now?.bridgeOnline && now.receiptPrinter) {
        try {
          await api.invoices.print(invoice.id);
          toast.success('Bill ' + invoice.invoiceNumber + ' sent to ' + now.receiptPrinter.name);
          printed();
          return;
        } catch (error) {
          if (!(error instanceof ApiRequestError) || !USE_BROWSER.has(error.code)) return reportError(error);
          void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
        }
      }
      browserPrint(invoice);
    })();
  }, [api, queryClient, status, browserPrint]);
}

/**
 * Prints kitchen tickets that did not already print at their stations: on the printer connected to
 * this device when one is, otherwise through the browser's print dialog. With `dialog: false` the
 * dialog is not opened; tickets then print only when a printer is connected here.
 */
export function usePrintKots(): (kots: KotDto[], options?: { dialog?: boolean }) => void {
  const api = useApi();
  const browserKots = usePrinter((printer) => printer.printKots);

  return useCallback((kots: KotDto[], options?: { dialog?: boolean }) => {
    if (kots.length === 0) return;
    void (async () => {
      let pending = kots;
      const local = useLocalPrinter.getState();
      const { layouts, timeZone } = usePrintSetup.getState();
      if (local.printer) {
        while (pending.length > 0) {
          const kot = pending[0]!;
          try {
            // A ticket made on this device offline is laid out here, and its printing is not reported to the server.
            if (isMadeOffline(kot.id) && layouts) {
              await local.print(renderKot(kot, layouts.kot, PAPER_COLUMNS[widthKey()], timeZone));
            } else {
              const document = await api.kots.printDocument(kot.id, widthKey());
              await local.print(document);
              await api.kots.printed(kot.id).catch(reportError);
            }
            pending = pending.slice(1);
          } catch (error) {
            if (error instanceof ApiRequestError) return reportError(error);
            toast.error('Could not print the kitchen ticket on ' + local.printer!.name + '. ' + (error instanceof Error ? error.message : ''), { duration: 10_000 });
            break;
          }
        }
        if (pending.length === 0) return;
      }
      if (options?.dialog !== false) browserKots(pending);
    })();
  }, [api, browserKots]);
}

/** Sends a cash register's report to the receipt printer. There is no browser version of this printout. */
export function usePrintRegisterReport(): (registerId: string) => Promise<void> {
  const api = useApi();
  return useCallback(async (registerId: string) => {
    const local = useLocalPrinter.getState();
    if (local.printer) {
      try {
        await local.print(await api.registers.printDocument(registerId, widthKey()));
        toast.success('Register report printed');
        return;
      } catch (error) {
        if (error instanceof ApiRequestError) return reportError(error);
        return void toast.error('Could not print on ' + local.printer.name + '. ' + (error instanceof Error ? error.message : ''), { duration: 10_000 });
      }
    }
    try {
      const job = await api.registers.print(registerId);
      toast.success('Register report sent to ' + (job.printerName ?? 'the printer'));
    } catch (error) {
      reportError(error);
    }
  }, [api]);
}
