/**
 * US-22 — Web Push (spec §4.1, §7 table, §8; FR-ST4, NFR-PERF1).
 *
 * The orchestrator side of away-from-keyboard alerts:
 *   - {@link shouldSendPush} — the FR-ST4 trigger predicate (push only on
 *     `awaiting_input` / `done` / `error`), reusing the shared status policy;
 *   - {@link PushSubscriptionStore} — durable subscription persistence
 *     (Drizzle in prod, in-memory in tests) over `push_subscriptions`;
 *   - {@link PushService} — subscribes to the in-memory status map and fans
 *     push-worthy transitions out OFF the live path (a slow sender never delays
 *     WS fan-out);
 *   - {@link createWebPushSender} — the VAPID transport (the only `web-push`
 *     importer);
 *   - {@link registerPushRoutes} — `POST`/`DELETE /api/push/subscribe`.
 *
 * Wiring (server bootstrap):
 *   const store = new DrizzlePushSubscriptionStore(db);
 *   const vapid = readVapidConfig();
 *   const push = new PushService({ store, sender: createWebPushSender(vapid) });
 *   push.attach(statusMap);            // off-live-path push on every transition
 *   registerPushRoutes(app, { store, resolveUserId, vapidPublicKey: vapid.publicKey });
 */
export { shouldSendPush } from './should-notify.js';
export {
  PushService,
  type PushNotificationPayload,
  type PushSender,
  type PushSendResult,
  type PushServiceDeps,
  type StatusTransitionSource,
} from './push-service.js';
export {
  DrizzlePushSubscriptionStore,
  InMemoryPushSubscriptionStore,
  type PushSubscriptionStore,
  type StoredPushSubscription,
} from './subscription-store.js';
export {
  createWebPushSender,
  readVapidConfig,
  type VapidConfig,
} from './sender.js';
export {
  registerPushRoutes,
  type PushRouteDeps,
  type ResolveUserId,
} from './routes.js';
