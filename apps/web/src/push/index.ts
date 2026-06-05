/**
 * US-22 — web client Web Push (spec §8.1; FR-ST4, FR-UI6).
 *
 * The browser-side enrollment for away-from-keyboard alerts: register the
 * service worker and subscribe to Web Push. The orchestrator owns the trigger
 * predicate (push only on `awaiting_input` / `done` / `error`); the service
 * worker (`public/sw.js`) shows the notification.
 */
export {
  SERVICE_WORKER_URL,
  enablePush,
  fetchVapidPublicKey,
  isPushSupported,
  isServiceWorkerSupported,
  registerServiceWorker,
  sendSubscriptionToServer,
  urlBase64ToUint8Array,
  type EnablePushResult,
} from './subscribe.js';
