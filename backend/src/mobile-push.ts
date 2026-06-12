// Mobile push notification fan-out for the Claudia RN companion app.
// Stores Expo push tokens per device and sends notifications via the Expo Push API.
//
// Notifications are designed to fire ONLY when something the user actually wants
// to know about happens — e.g. a task surfaces a `task:summary` event after
// settling. We do NOT push every state change. Silence = working.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Persisted to disk so registrations survive backend restarts.
const STORE_PATH = path.join(__dirname, '..', 'mobile-devices.json');

export interface MobileDevice {
  deviceId: string; // Stable device-generated id
  pushToken: string; // Expo push token (ExponentPushToken[...])
  platform: 'ios' | 'android' | 'web';
  registeredAt: string;
  lastSeenAt: string;
  label?: string; // Optional human label, e.g. "Lance's iPhone"
}

interface DeviceStore {
  devices: Record<string, MobileDevice>;
}

function loadStore(): DeviceStore {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      return JSON.parse(raw) as DeviceStore;
    }
  } catch (err) {
    console.error('[mobile-push] Failed to load device store:', err);
  }
  return { devices: {} };
}

function saveStore(store: DeviceStore): void {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[mobile-push] Failed to save device store:', err);
  }
}

let store: DeviceStore = loadStore();

export function registerDevice(input: {
  deviceId: string;
  pushToken: string;
  platform: 'ios' | 'android' | 'web';
  label?: string;
}): MobileDevice {
  const now = new Date().toISOString();
  const existing = store.devices[input.deviceId];
  const device: MobileDevice = {
    deviceId: input.deviceId,
    pushToken: input.pushToken,
    platform: input.platform,
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: now,
    label: input.label ?? existing?.label,
  };
  store.devices[input.deviceId] = device;
  saveStore(store);
  console.log(`[mobile-push] Registered device ${input.deviceId} (${input.platform})`);
  return device;
}

export function unregisterDevice(deviceId: string): boolean {
  if (store.devices[deviceId]) {
    delete store.devices[deviceId];
    saveStore(store);
    return true;
  }
  return false;
}

export function listDevices(): MobileDevice[] {
  return Object.values(store.devices);
}

/**
 * Send a push notification to all registered devices via the Expo Push API.
 * Web devices are skipped — Expo push tokens are native-only.
 *
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */
export async function sendPush(input: {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<{ sent: number; skipped: number; errors: string[] }> {
  const result = { sent: 0, skipped: 0, errors: [] as string[] };
  const devices = listDevices().filter((d) => d.platform !== 'web');
  if (devices.length === 0) {
    console.log('[mobile-push] No registered native devices; skipping push');
    return result;
  }

  const messages = devices.map((d) => ({
    to: d.pushToken,
    sound: 'default',
    title: input.title,
    body: input.body,
    data: input.data ?? {},
  }));

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      const text = await res.text();
      result.errors.push(`Expo push HTTP ${res.status}: ${text}`);
      console.error('[mobile-push] Expo push failed:', res.status, text);
      return result;
    }
    result.sent = messages.length;
    console.log(`[mobile-push] Sent ${messages.length} push notifications`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    console.error('[mobile-push] Push error:', msg);
  }
  return result;
}

/**
 * Reload the in-memory store from disk. Useful for tests and after manual
 * edits to mobile-devices.json.
 */
export function reloadStore(): void {
  store = loadStore();
}
