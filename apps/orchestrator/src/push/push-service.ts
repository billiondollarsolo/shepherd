/**
 * US-22 — Web Push dispatch service (spec §4.1, §7 table, §8; FR-ST4, NFR-PERF1).
 *
 * Bridges the in-memory status map (US-14) to Web Push: on every status
 * transition it decides, via {@link shouldSendPush}, whether the new state is
 * one of the three away-alert states (`awaiting_input` / `done` / `error`) and,
 * if so, fans a notification out to every stored subscription.
 *
 * Two non-negotiables this module enforces:
 *  1. **Trigger predicate (FR-ST4):** ONLY `awaiting_input`, `done`, `error`
 *     produce a push; `starting`, `running`, `idle`, `disconnected` never do.
 *  2. **Off the live path (NFR-PERF1):** the status-map subscription callback is
 *     on the live fan-out path, so it does ZERO work inline — it `defer()`s the
 *     "load subscriptions + send" to a microtask. A slow/blocked push sender can
 *     never delay or break the WS status fan-out. (Mirrors the StatusMap +
 *     WriteBehindEventQueue `defer` seam.)
 *
 * The actual VAPID transport is injected as a {@link PushSender} so this stays a
 * pure-logic unit; the production `web-push`-backed sender lives in `sender.ts`.
 * Dead endpoints (404/410 from the push service) are pruned from the store.
 */
import type { Status, StatusUpdateMessage } from '@flock/shared';

import { shouldSendPush } from './should-notify.js';
import type {
  PushSubscriptionStore,
  StoredPushSubscription,
} from './subscription-store.js';

/** The JSON payload delivered to the service worker (`event.data.json()`). */
export interface PushNotificationPayload {
  /** Notification title, e.g. "Agent needs input". */
  readonly title: string;
  /** Notification body, e.g. the session/detail line. */
  readonly body: string;
  /** Session the alert is about — the SW uses it to focus the right view. */
  readonly sessionId: string;
  /** The status that triggered the push (awaiting_input | done | error). */
  readonly status: Status;
}

/** Result of attempting one delivery. `gone` means prune this subscription. */
export type PushSendResult = 'ok' | 'gone' | 'error';

/**
 * Sends one push to one subscription. Injected so the unit tests run without the
 * network and the VAPID/`web-push` dependency is isolated in `sender.ts`. MUST
 * NOT throw — a transport failure is reported as `'error'`; a 404/410 (the
 * endpoint is dead) as `'gone'` so the caller can prune it.
 */
export type PushSender = (
  sub: StoredPushSubscription,
  payload: PushNotificationPayload,
) => Promise<PushSendResult>;

/** The slice of the status map this service needs (eases testing). */
export interface StatusTransitionSource {
  subscribe(fn: (msg: StatusUpdateMessage) => void): () => void;
}

export interface PushServiceDeps {
  /** Where stored subscriptions live (Drizzle in prod, in-memory in tests). */
  store: PushSubscriptionStore;
  /** The VAPID transport (web-push in prod, a fake in tests). */
  sender: PushSender;
  /**
   * Schedules the "load + send" work OFF the live path. Defaults to
   * `queueMicrotask`; injectable for deterministic tests. The status-map
   * subscription callback NEVER does DB/network work inline (NFR-PERF1).
   */
  defer?: (fn: () => void) => void;
  /** Reported when a delivery errors (logging/metrics). Never on the live path. */
  onError?: (sub: StoredPushSubscription, error: unknown) => void;
}

const defaultDefer = (fn: () => void): void => {
  queueMicrotask(fn);
};

/** Human-facing copy per push-worthy status (spec §7 table). */
function describe(status: Status, sessionId: string, detail: string | null): {
  title: string;
  body: string;
} {
  const shortId = sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
  switch (status) {
    case 'awaiting_input':
      return {
        title: 'Agent needs your input',
        body: detail ?? `Session ${shortId} is waiting on you.`,
      };
    case 'done':
      return {
        title: 'Agent finished',
        body: detail ?? `Session ${shortId} is done.`,
      };
    case 'error':
      return {
        title: 'Agent error',
        body: detail ?? `Session ${shortId} hit an error.`,
      };
    default:
      // Unreachable: only push-worthy statuses reach here (guarded by the
      // shouldSendPush predicate before this is called).
      return { title: 'Flock', body: `Session ${shortId}: ${status}` };
  }
}

/**
 * Wires Web Push to the status map. Construct it, call {@link attach} with the
 * status source, and every push-worthy transition thereafter fans out — off the
 * live path.
 */
export class PushService {
  private readonly store: PushSubscriptionStore;
  private readonly sender: PushSender;
  private readonly defer: (fn: () => void) => void;
  private readonly onError?: (sub: StoredPushSubscription, error: unknown) => void;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: PushServiceDeps) {
    this.store = deps.store;
    this.sender = deps.sender;
    this.defer = deps.defer ?? defaultDefer;
    this.onError = deps.onError;
  }

  /**
   * Subscribe to the status map. The callback is invoked SYNCHRONOUSLY on the
   * live path, so it only decides push-worthiness (pure, in-memory) and defers
   * everything else. Returns an unsubscribe handle; also stored for {@link close}.
   */
  attach(source: StatusTransitionSource): () => void {
    this.unsubscribe = source.subscribe((msg) => this.onTransition(msg));
    return () => this.close();
  }

  /** Detach from the status map; no further pushes are produced. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * The live-path callback. Does the MINIMUM synchronously: evaluate the trigger
   * predicate (FR-ST4) and bail for non-push states. Push-worthy transitions
   * schedule the load-and-send off the live path (NFR-PERF1).
   */
  private onTransition(msg: StatusUpdateMessage): void {
    if (!shouldSendPush(msg.status)) return;
    this.defer(() => {
      void this.dispatch(msg).catch(() => {
        /* dispatch contains its own errors; never propagate to the (already
           returned) live path. */
      });
    });
  }

  /**
   * Load every subscription and deliver the notification, pruning dead
   * endpoints. Runs exclusively off the live path. Never throws.
   */
  private async dispatch(msg: StatusUpdateMessage): Promise<void> {
    const subs = await this.store.listAll();
    if (subs.length === 0) return;

    const copy = describe(msg.status, msg.sessionId, msg.detail);
    const payload: PushNotificationPayload = {
      title: copy.title,
      body: copy.body,
      sessionId: msg.sessionId,
      status: msg.status,
    };

    await Promise.all(
      subs.map(async (sub) => {
        let result: PushSendResult;
        try {
          result = await this.sender(sub, payload);
        } catch (err) {
          this.onError?.(sub, err);
          return;
        }
        if (result === 'gone') {
          // The endpoint is dead (404/410): prune it so we stop retrying it.
          await this.store.removeByEndpoint(sub.endpoint).catch(() => {
            /* a failed prune is non-fatal; it will be retried next time. */
          });
        } else if (result === 'error') {
          this.onError?.(sub, new Error('push delivery failed'));
        }
      }),
    );
  }
}
