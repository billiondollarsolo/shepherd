/**
 * US-21 — Async write-behind event log (spec §4.1, §6, §15; NFR-PERF1).
 *
 * The seam that turns every status transition (US-14) and every raw hook
 * callback (US-15) into a durable `events` row WITHOUT putting Postgres on the
 * live path (spec §6.6). Callers `enqueue()` synchronously; a background loop
 * drains to Postgres via the Drizzle writer, with retries + a bounded buffer so
 * a slow/blocked/down DB can never delay or break fan-out.
 *
 * Wiring (done by the server bootstrap):
 *   const queue = new WriteBehindEventQueue({ writer: createDrizzleEventWriter(db) });
 *   const statusMap = new StatusMap({ writeBehind: queue.transitionSink() });
 *   const hookService = new HookEndpointService({ enqueueEvent: queue.hookEnqueue(), ... });
 */
export {
  WriteBehindEventQueue,
  type EventRecord,
  type EventWriter,
  type DropHandler,
  type ErrorHandler,
  type WriteBehindEventQueueOptions,
} from './queue.js';
export { createDrizzleEventWriter } from './drizzle-event-writer.js';
export { EventReadService } from './event-read-service.js';
export { registerEventRoute } from './event-route.js';
