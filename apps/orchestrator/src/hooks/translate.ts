/**
 * Hook event → {@link Status} dispatch (spec §7.1).
 *
 * The hook endpoint (US-15) derives a status from an incoming agent event so it
 * can update the in-memory status map. This module is the per-agent DISPATCHER:
 * it selects a pure, framework-free translator by `agent_type` (or infers the
 * agent from the payload shape) and returns its mapping.
 *
 * The first-class translators are exhaustively pinned by recorded-fixture
 * contract tests living beside them: US-16 Claude (`status/translators/claude`),
 * US-17 Codex (`status/translators/codex`), US-18 OpenCode
 * (`status/translators/opencode`). Each agent path delegates to its dedicated
 * translator so the §7.1 contract for that agent has a single implementation.
 *
 * All translators validate against the shared hook payload schemas so the
 * mapping is driven by the single source of truth (`@flock/shared`), never a
 * duplicated shape. An unrecognized event returns `null` ("no transition") —
 * the endpoint still acks and still logs the raw event.
 */
import type { AgentType, HookTelemetry, Status } from '@flock/shared';

import { translateClaudeHook } from '../status/translators/claude.js';
import { translateCodexHook } from '../status/translators/codex.js';
import { translateOpenCodeHook } from '../status/translators/opencode.js';
import { translateGrokHook } from '../status/translators/grok.js';

/**
 * A derived live frame. `translateHookEvent` returns `null` when an event maps
 * to nothing at all. `status: null` is a TELEMETRY-ONLY frame (no status change,
 * but `telemetry` is present — e.g. OpenCode `message.updated`).
 */
export interface TranslatedHook {
  readonly status: Status | null;
  readonly detail: string | null;
  /** Raw per-turn telemetry (model/tokens/cost), when the event carries it. */
  readonly telemetry?: HookTelemetry;
}

/**
 * Translate a raw agent hook event into a live status transition, or `null` if
 * the event maps to no transition.
 *
 * When `agentType` is supplied the matching translator is used directly; when it
 * is omitted the agent is inferred from the payload's discriminating field
 * (`hook_event_name` → Claude, `hookEventName` → Grok, `event` → Codex,
 * `type` → OpenCode), so the fast path works even before the per-session agent
 * type is threaded through.
 */
export function translateHookEvent(body: unknown, agentType?: AgentType): TranslatedHook | null {
  switch (agentType) {
    case 'claude-code':
      return translateClaudeHook(body);
    case 'codex':
      return translateCodexHook(body);
    case 'opencode':
      return translateOpenCodeHook(body);
    case 'grok':
      return translateGrokHook(body);
    case 'terminal':
      // A plain terminal has no structured hook payload.
      return null;
    default:
      break;
  }

  // No explicit agent type: infer from the payload's discriminating field.
  if (body !== null && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if ('hook_event_name' in obj) return translateClaudeHook(body);
    if ('hookEventName' in obj) return translateGrokHook(body);
    if ('event' in obj) return translateCodexHook(body);
    if ('type' in obj) return translateOpenCodeHook(body);
  }
  return null;
}
