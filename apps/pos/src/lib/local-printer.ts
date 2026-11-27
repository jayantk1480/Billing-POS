'use client';

import type { PrintDocument } from '@pos/types';
import { create } from 'zustand';
import { encode } from './escpos';

/**
 * A thermal printer connected to this device itself, through the browser: over USB (WebUSB), over Bluetooth Low
 * Energy (Web Bluetooth), or over a serial port, which is also how a Bluetooth Classic printer paired with the
 * computer appears (Web Serial). The API lays the printout out; this file only opens the connection and sends the
 * ESC/POS bytes.
 *
 * Chrome and Edge have all three on computers; on Android phones and tablets, USB and Bluetooth. Safari and Firefox
 * have none. The browser remembers a USB or serial permission, so that printer reconnects by itself when the page is
 * opened again; a Bluetooth printer is picked again after the page is reloaded, unless the browser can list devices
 * it was allowed before.
 */

export type LocalPrinterKind = 'usb' | 'bluetooth' | 'serial';

// ── The slice of WebUSB and Web Serial this file uses; the DOM library does not declare them. ──

interface UsbEndpoint { direction: 'in' | 'out'; endpointNumber: number }
interface UsbAlternate { interfaceClass: number; endpoints: UsbEndpoint[] }
interface UsbInterface { interfaceNumber: number; alternate: UsbAlternate }
interface UsbConfiguration { configurationValue: number; interfaces: UsbInterface[] }
interface UsbDevice {
  productName?: string;
  opened: boolean;
  configuration: UsbConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status?: string }>;
}
interface Usb {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(options: { filters: unknown[] }): Promise<UsbDevice>;
  addEventListener(type: 'disconnect', listener: (event: { device: UsbDevice }) => void): void;
}
interface SerialPort {
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
interface Serial {
  getPorts(): Promise<SerialPort[]>;
  requestPort(): Promise<SerialPort>;
  addEventListener(type: 'disconnect', listener: (event: { target: unknown }) => void): void;
}

interface BleCharacteristic {
  uuid: string;
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}
interface BleService { uuid: string; getCharacteristics(): Promise<BleCharacteristic[]> }
interface BleServer { connected: boolean; connect(): Promise<BleServer>; disconnect(): void; getPrimaryServices(): Promise<BleService[]> }
interface BleDevice extends EventTarget { id: string; name?: string; gatt?: BleServer }
interface Bluetooth {
  getAvailability?(): Promise<boolean>;
  getDevices?(): Promise<BleDevice[]>;
  requestDevice(options: { acceptAllDevices: boolean; optionalServices: string[] }): Promise<BleDevice>;
}

/**
 * The Bluetooth Low Energy services thermal receipt printers use to take data, most common first. A browser may only
 * open the services named when the printer is chosen, so the list is generous; whichever of them the printer has, the
 * first channel that can be written to carries the printout.
 */
export const BLE_PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // the most common on 58 mm and 80 mm printers
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip (ISSC) transparent serial
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ffe5-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
];
/** Every Bluetooth Low Energy link carries at least 20 bytes in one write, so printouts go in pieces of that size. */
export const BLE_CHUNK_BYTES = 20;
/** Without acknowledgements a small printer can be flooded; a short pause between pieces lets its buffer drain. */
const BLE_PAUSE_MS = 6;

const usbOf = () => (typeof navigator === 'undefined' ? undefined : (navigator as { usb?: Usb }).usb);
const bluetoothOf = () => (typeof navigator === 'undefined' ? undefined : (navigator as { bluetooth?: Bluetooth }).bluetooth);
const serialOf = () => (typeof navigator === 'undefined' ? undefined : (navigator as { serial?: Serial }).serial);

/** Which kind was connected on this device, so it can be picked up again without asking. */
const REMEMBER_KEY = 'pos-local-printer';
/** The Bluetooth printer chosen on this device, for browsers that can list devices allowed before. */
const REMEMBER_BLE_KEY = 'pos-local-printer-ble';

// The handles live outside the store: they are not state to render, and they cannot be serialised.
let usbDevice: UsbDevice | null = null;
let usbEndpoint = 0;
let serialPort: SerialPort | null = null;
let bleDevice: BleDevice | null = null;
let bleChannel: BleCharacteristic | null = null;
// Printouts go out one after another, so two bills printed together cannot interleave their bytes.
let sending: Promise<void> = Promise.resolve();

/** The browser's errors name APIs, not the problem; say what the cashier can act on. */
function plainWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unable to claim|claimInterface|protected/i.test(message)) {
    return 'Another program on this computer holds the printer. Close it (or uninstall the printer driver) and connect again.';
  }
  if (/access denied/i.test(message)) {
    return 'This computer\'s printer driver holds the printer, so the browser cannot use it. Use the Bluetooth or print bridge connection instead.';
  }
  if (/adapter not available|bluetooth is not available|bluetooth adapter/i.test(message)) {
    return 'Bluetooth is off on this device. Switch it on and connect again.';
  }
  if (/globally disabled|permission|not allowed/i.test(message)) {
    return 'The browser may not use Bluetooth here. On a Mac: System Settings, Privacy & Security, Bluetooth, and allow Chrome (or Edge).';
  }
  if (/gatt|connection attempt failed|failed to connect|out of range/i.test(message)) {
    return 'Could not reach the Bluetooth printer. Check that it is on and close by, and that no other phone or POS is connected to it: it talks to one device at a time.';
  }
  if (/disconnected|device was lost|no device|network error/i.test(message)) return 'The printer is no longer connected. Check the cable and connect again.';
  return message;
}

async function openUsb(device: UsbDevice): Promise<void> {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const interfaces = device.configuration?.interfaces ?? [];
  // The printer interface (class 7) when there is one; otherwise anything the bytes can be written to.
  const usable = interfaces.filter((entry) => entry.alternate.endpoints.some((endpoint) => endpoint.direction === 'out'));
  const chosen = usable.find((entry) => entry.alternate.interfaceClass === 7) ?? usable[0];
  if (!chosen) throw new Error('This USB device has nothing to print to, so it does not look like a printer.');
  await device.claimInterface(chosen.interfaceNumber);
  usbDevice = device;
  usbEndpoint = chosen.alternate.endpoints.find((endpoint) => endpoint.direction === 'out')!.endpointNumber;
}

/** Connects to a Bluetooth printer and finds the channel printouts are written to. */
async function openBluetooth(device: BleDevice): Promise<void> {
  if (!device.gatt) throw new Error('This Bluetooth device cannot be connected to.');
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();
  // In the order of the list above, so a printer with several services is written to through its usual one.
  const rank = (uuid: string) => (BLE_PRINTER_SERVICES.includes(uuid) ? BLE_PRINTER_SERVICES.indexOf(uuid) : BLE_PRINTER_SERVICES.length);
  services.sort((a, b) => rank(a.uuid) - rank(b.uuid));
  for (const service of services) {
    const channel = (await service.getCharacteristics()).find((c) => c.properties.writeWithoutResponse || c.properties.write);
    if (channel) {
      bleDevice = device;
      bleChannel = channel;
      return;
    }
  }
  server.disconnect();
  throw new Error(
    'This Bluetooth device has no printing service the POS knows. If it is a printer, pair it with this computer and choose "Paired Bluetooth or serial port" instead.',
  );
}

/** Sends a printout to the Bluetooth printer in small pieces, reconnecting first if the printer let the link drop. */
async function writeBluetooth(data: Uint8Array): Promise<void> {
  if (bleDevice && !bleDevice.gatt?.connected) await openBluetooth(bleDevice);
  const channel = bleChannel!;
  const quick = channel.properties.writeWithoutResponse;
  for (let at = 0; at < data.length; at += BLE_CHUNK_BYTES) {
    const piece = data.slice(at, at + BLE_CHUNK_BYTES);
    if (quick) {
      await channel.writeValueWithoutResponse(piece);
      await new Promise((resolve) => setTimeout(resolve, BLE_PAUSE_MS));
    } else {
      await channel.writeValueWithResponse(piece);
    }
  }
}

async function openSerial(port: SerialPort): Promise<void> {
  // 9600 baud is what thermal printers ship with; over Bluetooth the rate is ignored.
  await port.open({ baudRate: 9600 });
  serialPort = port;
}

interface LocalPrinterStore {
  /** The ways this browser can reach a printer. Empty on browsers without WebUSB and Web Serial. */
  supported: LocalPrinterKind[];
  /** The connected printer, or null. */
  printer: { kind: LocalPrinterKind; name: string } | null;
  /** Set while connecting, so two pickers cannot open at once. */
  busy: boolean;
  /** Detects support, listens for the cable being pulled, and quietly reconnects a printer used before. */
  init: () => void;
  /** Asks the browser for a device and connects it. Returns false when the cashier closed the picker. */
  connect: (kind: LocalPrinterKind) => Promise<boolean>;
  disconnect: () => Promise<void>;
  /** Encodes the printout and sends it to the connected printer. */
  print: (document: PrintDocument) => Promise<void>;
}

let initialised = false;

export const useLocalPrinter = create<LocalPrinterStore>()((set, get) => {
  const connected = (kind: LocalPrinterKind, name: string) => {
    set({ printer: { kind, name }, busy: false });
    try {
      window.localStorage.setItem(REMEMBER_KEY, kind);
    } catch {
      // Private windows forget the printer between visits; nothing else is lost.
    }
  };

  const gone = () => {
    usbDevice = null;
    serialPort = null;
    bleDevice = null;
    bleChannel = null;
    set({ printer: null });
  };

  return {
    supported: [],
    printer: null,
    busy: false,

    init: () => {
      if (initialised || typeof navigator === 'undefined') return;
      initialised = true;
      const usb = usbOf();
      const bluetooth = bluetoothOf();
      const serial = serialOf();
      set({ supported: [...(usb ? ['usb' as const] : []), ...(bluetooth ? ['bluetooth' as const] : []), ...(serial ? ['serial' as const] : [])] });
      usb?.addEventListener('disconnect', (event) => {
        if (event.device === usbDevice) gone();
      });
      serial?.addEventListener('disconnect', (event) => {
        if (event.target === serialPort) gone();
      });

      // A printer connected here before: the permission is remembered, so take it up again without asking.
      let remembered: string | null = null;
      try {
        remembered = window.localStorage.getItem(REMEMBER_KEY);
      } catch {
        return;
      }
      void (async () => {
        try {
          if (remembered === 'usb' && usb) {
            const [device] = await usb.getDevices();
            if (device) {
              await openUsb(device);
              connected('usb', device.productName?.trim() || 'USB printer');
            }
          } else if (remembered === 'bluetooth' && bluetooth?.getDevices) {
            const id = window.localStorage.getItem(REMEMBER_BLE_KEY);
            const device = (await bluetooth.getDevices()).find((candidate) => candidate.id === id);
            if (device) {
              await openBluetooth(device);
              connected('bluetooth', device.name?.trim() || 'Bluetooth printer');
            }
          } else if (remembered === 'serial' && serial) {
            const [port] = await serial.getPorts();
            if (port) {
              await openSerial(port);
              connected('serial', 'Serial printer');
            }
          }
        } catch {
          // The printer is off or taken by another program; the Connect button is there when it is back.
        }
      })();
    },

    connect: async (kind) => {
      if (get().busy) return false;
      set({ busy: true });
      try {
        await get().disconnect();
        if (kind === 'usb') {
          // No filter: cheap thermal printers often do not declare the printer class, so the cashier picks.
          const device = await usbOf()!.requestDevice({ filters: [] });
          await openUsb(device);
          connected('usb', device.productName?.trim() || 'USB printer');
        } else if (kind === 'bluetooth') {
          // Every nearby device is offered: many printers do not announce their printing service until connected.
          const device = await bluetoothOf()!.requestDevice({ acceptAllDevices: true, optionalServices: BLE_PRINTER_SERVICES });
          await openBluetooth(device);
          connected('bluetooth', device.name?.trim() || 'Bluetooth printer');
          try {
            window.localStorage.setItem(REMEMBER_BLE_KEY, device.id);
          } catch {
            // Only the quiet reconnect after a reload is lost.
          }
        } else {
          const port = await serialOf()!.requestPort();
          await openSerial(port);
          connected('serial', 'Serial printer');
        }
        return true;
      } catch (error) {
        set({ busy: false });
        // The cashier closed the browser's picker without choosing: not an error. (Bluetooth being off is also a
        // NotFoundError, and is one.)
        if (error instanceof DOMException && error.name === 'NotFoundError' && !/adapter|not available/i.test(error.message)) return false;
        throw new Error(plainWords(error));
      }
    },

    disconnect: async () => {
      const device = usbDevice;
      const port = serialPort;
      const ble = bleDevice;
      gone();
      try {
        window.localStorage.removeItem(REMEMBER_KEY);
      } catch {
        // Nothing was remembered.
      }
      try {
        await device?.close();
        await port?.close();
        if (ble?.gatt?.connected) ble.gatt.disconnect();
      } catch {
        // Already unplugged.
      }
    },

    print: async (document) => {
      const data = encode(document);
      const turn = sending.then(async () => {
        if (usbDevice) {
          const result = await usbDevice.transferOut(usbEndpoint, data as BufferSource);
          if (result.status && result.status !== 'ok') throw new Error('The printer did not accept the data. Check that it is on and has paper.');
        } else if (bleDevice && bleChannel) {
          await writeBluetooth(data);
        } else if (serialPort?.writable) {
          const writer = serialPort.writable.getWriter();
          try {
            await writer.write(data);
          } finally {
            writer.releaseLock();
          }
        } else {
          throw new Error('No printer is connected to this device.');
        }
      });
      // The next printout waits for this one, whether it printed or failed.
      sending = turn.catch(() => undefined);
      try {
        await turn;
      } catch (error) {
        throw new Error(plainWords(error));
      }
    },
  };
});

/** A short page to check the paper width, the characters and the cutter. */
export function testPage(columns: number): PrintDocument {
  const now = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  return {
    columns,
    copies: 1,
    openDrawer: false,
    lines: [
      { kind: 'text', text: 'PRINTER CONNECTED', align: 'center', bold: true, size: 'large' },
      { kind: 'text', text: now, align: 'center' },
      { kind: 'rule' },
      { kind: 'text', text: `Paper set to ${columns === 32 ? '58' : '80'} mm (${columns} characters):` },
      { kind: 'text', text: '123456789'.repeat(5).slice(0, columns) },
      { kind: 'text', text: 'If the line above wraps or stops short,', align: 'center' },
      { kind: 'text', text: 'change Receipt paper in the user menu.', align: 'center' },
      { kind: 'feed', lines: 1 },
    ],
  };
}
