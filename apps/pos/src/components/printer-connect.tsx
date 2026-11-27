'use client';

import { Button, Dialog, toast } from '@pos/ui';
import { Bluetooth, Cable, CheckCircle2, Printer, Usb } from 'lucide-react';
import { useState } from 'react';
import { type LocalPrinterKind, testPage, useLocalPrinter } from '@/lib/local-printer';
import { usePrinter } from './receipt';

/**
 * Connects a receipt printer to this device through the browser: over USB, or over Bluetooth or a
 * serial port. Once connected, bills and kitchen tickets print on it with no dialog, and the
 * printer is managed from the user menu.
 */
export function ConnectPrinterDialog({ onClose }: { onClose: () => void }) {
  const { supported, printer, busy, connect, disconnect, print } = useLocalPrinter();
  const width = usePrinter((state) => state.width);
  const [testing, setTesting] = useState(false);

  async function pick(kind: LocalPrinterKind) {
    try {
      if (await connect(kind)) toast.success('Printer connected. Bills will print on it.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { duration: 10_000 });
    }
  }

  async function test() {
    setTesting(true);
    try {
      await print(testPage(width === 58 ? 32 : 48));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { duration: 10_000 });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={printer ? 'Printer connected' : 'Connect a printer'}
      description={printer ? undefined : 'A thermal receipt printer attached to this device. The browser will ask which one to use.'}
      footer={<Button variant="secondary" size="touch" onClick={onClose}>{printer ? 'Done' : 'Close'}</Button>}
    >
      {printer ? (
        <div className="flex flex-col items-center py-2 text-center">
          <CheckCircle2 className="size-12 text-ok" />
          <p className="mt-3 text-lg font-semibold text-ink-900">{printer.name}</p>
          <p className="mt-1 text-sm text-ink-500">
            Bills and kitchen tickets now print here without a dialog. Set the paper width ({width} mm now) under Receipt paper in the user menu.
          </p>
          <div className="mt-5 grid w-full gap-2">
            <Button variant="secondary" size="touch" loading={testing} onClick={() => void test()}><Printer className="size-5" /> Print a test page</Button>
            <Button variant="ghost" size="touch" onClick={() => void disconnect()}>Disconnect</Button>
          </div>
        </div>
      ) : supported.length === 0 ? (
        <p className="text-sm text-ink-700">
          This browser cannot talk to a printer directly. Use Chrome or Edge on this computer, or set up the
          print bridge under Settings, Printers in the back office; printing falls back to the browser&apos;s
          print dialog meanwhile.
        </p>
      ) : (
        <div className="grid gap-2">
          {supported.includes('usb') && (
            <Button variant="secondary" size="touch" className="justify-start" loading={busy} onClick={() => void pick('usb')}>
              <Usb className="size-5" /> USB printer
            </Button>
          )}
          {supported.includes('bluetooth') && (
            <Button variant="secondary" size="touch" className="justify-start" loading={busy} onClick={() => void pick('bluetooth')}>
              <Bluetooth className="size-5" /> Bluetooth printer
            </Button>
          )}
          {supported.includes('serial') && (
            <Button variant="secondary" size="touch" className="justify-start" loading={busy} onClick={() => void pick('serial')}>
              <Cable className="size-5" /> Paired Bluetooth or serial port
            </Button>
          )}
          {supported.includes('bluetooth') && (
            <div className="mt-1 rounded-lg bg-canvas p-3 text-xs text-ink-700">
              <p className="font-semibold text-ink-900">If a Bluetooth printer is not in the list</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Disconnect it from any other phone or POS, or switch their Bluetooth off: a printer talks to one device at a time and cannot be found while another is connected.</li>
                <li>Switch the printer off and on, and keep it close to this device.</li>
                <li>On a Mac, allow the browser to use Bluetooth: System Settings, Privacy &amp; Security, Bluetooth.</li>
                <li>Still missing? Pair it in this device&apos;s Bluetooth settings and use &quot;Paired Bluetooth or serial port&quot;.</li>
              </ul>
            </div>
          )}
          <p className="mt-1 text-xs text-ink-500">
            Plug a USB printer in before connecting. A printer on the restaurant&apos;s network is set up under Settings,
            Printers in the back office instead, with the print bridge.
          </p>
        </div>
      )}
    </Dialog>
  );
}
