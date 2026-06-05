/**
 * US-22 — web client Web Push subscribe flow (spec §8.1; FR-ST4, FR-UI6).
 *
 * Registers the service worker (`/sw.js`) and enrolls the browser for Web Push:
 *   1. feature-detect Service Worker + Push support (older browsers degrade);
 *   2. register the SW at the root scope;
 *   3. fetch the VAPID public key from the orchestrator;
 *   4. request notification permission and `pushManager.subscribe`;
 *   5. POST the resulting subscription to `POST /api/push/subscribe`.
 *
 * The orchestrator owns the trigger predicate (push only on `awaiting_input` /
 * `done` / `error`); this module is purely the enrollment side. Each step is a
 * small exported function so the registration step (the acceptance criterion's
 * "web test for the SW registration") is unit-testable in jsdom without a real
 * push service.
 */

/** True when the browser can register a service worker. */
export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** True when the browser supports the Push API (implies SW support). */
export function isPushSupported(): boolean {
  return (
    isServiceWorkerSupported() &&
    typeof window !== 'undefined' &&
    'PushManager' in window
  );
}

/** The path the service worker is served from (root scope). */
export const SERVICE_WORKER_URL = '/sw.js';

/**
 * Register the Flock service worker at the root scope. Returns the registration,
 * or `null` when service workers are unsupported (no throw — callers can degrade
 * to the in-tab WS sidebar without Web Push).
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return null;
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
}

/**
 * Convert a base64url VAPID public key to the `Uint8Array` `applicationServerKey`
 * that `pushManager.subscribe` requires.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Fetch the orchestrator's VAPID public key (authed via the session cookie). */
export async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to fetch VAPID public key: ${res.status}`);
  }
  const body = (await res.json()) as { publicKey: string };
  return body.publicKey;
}

/** POST a browser PushSubscription to the orchestrator (`/api/push/subscribe`). */
export async function sendSubscriptionToServer(
  subscription: PushSubscription,
): Promise<void> {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    // `toJSON()` yields { endpoint, keys: { p256dh, auth } } — the shared
    // PushSubscribeRequest shape exactly.
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) {
    throw new Error(`Failed to register push subscription: ${res.status}`);
  }
}

/** Outcome of {@link enablePush}. */
export type EnablePushResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'denied' | 'error'; error?: unknown };

/**
 * Full enrollment flow: register the SW, get permission, subscribe, and tell the
 * server. Idempotent — re-running reuses any existing subscription. Returns a
 * tagged result instead of throwing so the UI can show a calm message.
 */
export async function enablePush(): Promise<EnablePushResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  try {
    const registration = await registerServiceWorker();
    if (!registration) return { ok: false, reason: 'unsupported' };

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(await fetchVapidPublicKey()),
      }));

    await sendSubscriptionToServer(subscription);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'error', error };
  }
}
