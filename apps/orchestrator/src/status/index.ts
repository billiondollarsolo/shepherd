/**
 * US-14 — in-memory status map + `status` WS fan-out (spec §6.6, §7, §8.2).
 *
 * The live status path: every transition mutates {@link StatusMap} and is fanned
 * out over {@link StatusChannel} with ZERO synchronous DB access (NFR-PERF1).
 * Postgres is a write-behind mirror only.
 */
export {
  StatusMap,
  type StatusEntry,
  type StatusSubscriber,
  type Unsubscribe,
  type WriteBehindSink,
  type StatusMapOptions,
} from './map.js';
export { StatusChannel, type StatusSocket } from './channel.js';
export { rehydrateStatus, type OpenStatusRow } from './rehydrate.js';
export {
  planSessionTruth,
  type NodeTruth,
  type SessionTruthCorrection,
  type SessionTruthRow,
} from './session-truth.js';
