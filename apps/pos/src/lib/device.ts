'use client';

import { ApiRequestError } from '@pos/api-client';
import type { PosDeviceDto } from '@pos/validation';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { mergeNumbers } from './offline-numbers';

const KEY = 'pos.deviceKey';
const deviceStorageKey = (restaurantId: string) => `pos.device.${restaurantId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This device's key, if it has one yet. */
export function storedDeviceKey(): string | null {
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved && UUID.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** This device's own key, chosen once and kept: registering again with it always returns the same device. */
function deviceKey(): string {
  const saved = window.localStorage.getItem(KEY);
  if (saved && UUID.test(saved)) return saved;
  const key = crypto.randomUUID();
  window.localStorage.setItem(KEY, key);
  return key;
}

/** The device as people would recognise it in a list: "Chrome on Android". */
function describeDevice(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const system = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

function readDevice(restaurantId: string): PosDeviceDto | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(deviceStorageKey(restaurantId)) ?? 'null') as PosDeviceDto | null;
    return saved && typeof saved.offlineCode === 'string' ? saved : null;
  } catch {
    return null;
  }
}

/** This device as the restaurant knows it: its offline code, once it has registered. */
export const useDevice = create<{ device: PosDeviceDto | null }>(() => ({ device: null }));

/** Restaurants this device has registered with since the app opened: once per opening is enough. */
const registered = new Set<string>();

/**
 * Registers this device with the restaurant once each time the app opens and the server is there, so it has its own
 * offline code (its bills made offline are numbered in that series). Also asks the browser to keep the app's data on
 * the device rather than clear it when space runs low.
 */
export function useDeviceRegistration(restaurantId: string | undefined, online: boolean): void {
  useEffect(() => {
    if (!restaurantId) return;
    useDevice.setState({ device: readDevice(restaurantId) });
    if (!online || registered.has(restaurantId)) return;
    registered.add(restaurantId);
    void navigator.storage?.persist?.().catch(() => false);
    let key: string;
    try {
      key = deviceKey();
    } catch {
      return; // Storage blocked: without a key kept, the device cannot be told apart next time.
    }
    api.pos.registerDevice({ deviceKey: key, label: describeDevice() }).then(
      (device) => {
        try {
          window.localStorage.setItem(deviceStorageKey(restaurantId), JSON.stringify(device));
        } catch {
          // Known for this session only.
        }
        useDevice.setState({ device });
        // A device that lost its storage carries on from where its series stand on the server.
        void mergeNumbers(restaurantId, device.numbers).catch(() => undefined);
      },
      (error: unknown) => {
        if (error instanceof ApiRequestError && error.code === 'DEVICE_REVOKED') {
          window.localStorage.removeItem(deviceStorageKey(restaurantId));
          useDevice.setState({ device: null });
          return;
        }
        // Not reached, or not allowed to take orders: try again the next time the app opens or the server comes back.
        registered.delete(restaurantId);
      },
    );
  }, [restaurantId, online]);
}
