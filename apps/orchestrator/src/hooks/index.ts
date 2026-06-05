/**
 * US-15 — Hook endpoint + per-session token auth (spec §8.1, §15; NFR-SEC3).
 *
 * `POST /api/hooks/:sessionId`: the one endpoint authed by the per-session
 * token (Authorization header), and the one hot path that stays DB-free —
 * session lookup is the in-memory live binding and the event write is enqueued
 * off the live path (NFR-PERF1).
 */
export {
  HookEndpointService,
  HookSessionNotFoundError,
  HookUnauthorizedError,
  extractBearerToken,
  type HookEndpointServiceDeps,
  type HookSessionLookup,
  type HookSessionAuth,
  type HookTokenVerifier,
  type HookTransition,
  type HookTransitionSink,
  type HookEventRecord,
  type HookEventEnqueue,
  type HandleHookInput,
  type HookCallbackAck,
} from './endpoint.js';
export { registerHookRoute, type HookRouteService } from './routes.js';
export { translateHookEvent, type TranslatedHook } from './translate.js';
