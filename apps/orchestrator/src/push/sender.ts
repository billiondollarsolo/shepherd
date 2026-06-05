/**
 * US-22 — VAPID Web Push transport (spec §8; FR-ST4).
 *
 * The production {@link PushSender}: wraps the `web-push` library with the
 * orchestrator's VAPID identity and maps its outcomes to the
 * `'ok' | 'gone' | 'error'` result the push service expects. This is the ONLY
 * file that imports `web-push`, so the service + predicate stay pure and the
 * network dependency is isolated and never on the live path.
 *
 * VAPID keys come from the environment (NFR-DEP2 — secrets external, not baked):
 *   VAPID_PUBLIC_KEY   — base64url application server public key
 *   VAPID_PRIVATE_KEY  — base64url application server private key
 *   VAPID_SUBJECT      — a mailto: or https: contact URL (defaults to a mailto)
 * The same public key is served to the client so it can subscribe.
 */
import webpush from 'web-push';

import type {
  PushNotificationPayload,
  PushSender,
  PushSendResult,
} from './push-service.js';
import type { StoredPushSubscription } from './subscription-store.js';

/** Resolved VAPID configuration for the push sender. */
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` contact; web-push requires a subject. */
  subject: string;
}

/**
 * Read the VAPID config from the environment. Throws a clear error if the keys
 * are absent so a misconfigured deploy fails fast (spec §10 — clear startup
 * error on missing key material) rather than silently never sending pushes.
 */
export function readVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) {
    throw new Error(
      'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set for Web Push (US-22). ' +
        'Generate a key pair with `web-push generate-vapid-keys`.',
    );
  }
  const subject = env.VAPID_SUBJECT?.trim() || 'mailto:flock@localhost';
  return { publicKey, privateKey, subject };
}

/**
 * Build a `web-push`-backed {@link PushSender}. Never throws: a dead endpoint
 * (HTTP 404/410) returns `'gone'` so the caller prunes it; any other failure
 * returns `'error'`.
 */
export function createWebPushSender(config: VapidConfig): PushSender {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  return async (
    sub: StoredPushSubscription,
    payload: PushNotificationPayload,
  ): Promise<PushSendResult> => {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
      );
      return 'ok';
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        return 'gone';
      }
      return 'error';
    }
  };
}
