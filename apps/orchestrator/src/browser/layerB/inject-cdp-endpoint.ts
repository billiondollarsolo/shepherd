import {
  DO_NOT_LAUNCH_BROWSER_INSTRUCTION,
  LAYER_B_MECHANISM_V1,
  OpaqueCdpEndpoint,
  SESSION_BROWSER_CDP_ENV,
  SESSION_BROWSER_NO_LAUNCH_ENV,
  SESSION_BROWSER_NO_LAUNCH_VALUE,
  type LayerBMechanism,
} from '@flock/shared';

/**
 * Layer B — inject the opaque CDP endpoint into the session env (US-26, FR-B2,
 * spec §6.5 "Layer B").
 *
 * The orchestrator (the brain — nodes stay dumb couriers, spec §6.4) is the
 * only place that knows a session's browser CDP endpoint. At session create it
 * injects that endpoint into the agent's environment as `SESSION_BROWSER_CDP`
 * and sets a directive telling the agent NOT to launch its own browser, so the
 * agent drives the SAME isolated Chrome (Layer A) the user watches (Layer C).
 *
 * v1 ships native/MCP driving as the Layer B mechanism; the editable
 * browser-harness is deferred until the US-0b spike clears
 * (docs/decisions/browser-driving.md).
 *
 * Hard rule (PRD §6.5 Layer B): the injected value is a full ws URL carrying an
 * unguessable GUID and NEVER a bare port. This module validates that before it
 * hands the value to the agent.
 */

/** v1 Layer B driving mechanism (re-exported for callers wiring agent config). */
export const LAYER_B_MECHANISM: LayerBMechanism = LAYER_B_MECHANISM_V1;

/** Loopback host the per-session Chrome container is reverse-tunneled to. */
const LAYER_B_LOOPBACK_HOST = 'flock-browser';

/**
 * The minimal slice of the single authoritative session record (spec §4.2) this
 * module reads. The same `id` (session_id) that names the tmux session + scopes
 * the hook token also binds `browserCdpEndpoint` — one record, one identity.
 */
export interface LayerBSession {
  /** The session_id (uuid) — the one identity threaded through every subsystem. */
  id: string;
  /**
   * The opaque CDP ws endpoint bound on the record (incl. the GUID), or null
   * when no browser has been started for this session yet.
   */
  browserCdpEndpoint: string | null;
}

/**
 * Build the canonical opaque CDP endpoint for a session. The session_id (a
 * GUID) IS the unguessable token in the path, and the authority is a loopback
 * host with NO bare port — so the agent receives an endpoint it cannot reach by
 * port-scanning, only by holding the GUID (PRD §6.5 Layer B; NFR-SEC5).
 *
 * Layer A (US-25) is the source of truth for the live endpoint; this helper
 * gives a deterministic, opaque default that satisfies the same contract and is
 * used when seeding the record / in tests.
 */
export function opaqueCdpEndpointForSession(sessionId: string): string {
  return `ws://${LAYER_B_LOOPBACK_HOST}/devtools/browser/${sessionId}`;
}

/**
 * The Layer B env injected into the session (FR-B2). When a browser is bound,
 * returns `{ SESSION_BROWSER_CDP, SESSION_BROWSER_NO_LAUNCH }`; when no browser
 * is bound yet, returns an empty object (nothing to inject).
 *
 * Throws if the bound endpoint is not opaque (e.g. leaks a bare port) — that is
 * a programming error upstream and must never be handed to an agent.
 */
export function buildLayerBSessionEnv(
  session: LayerBSession,
): Partial<Record<string, string>> {
  const endpoint = session.browserCdpEndpoint;
  if (!endpoint) {
    return {};
  }

  // Defend the no-bare-port / GUID-present invariant at the injection boundary.
  // `.parse` throws a ZodError on a non-opaque endpoint — exactly the "must
  // never be handed to an agent" behavior — and returns the validated string.
  let opaque: string;
  try {
    opaque = OpaqueCdpEndpoint.parse(endpoint);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `refusing to inject a non-opaque CDP endpoint for session ${session.id}: ${detail}`,
    );
  }

  return {
    [SESSION_BROWSER_CDP_ENV]: opaque,
    [SESSION_BROWSER_NO_LAUNCH_ENV]: SESSION_BROWSER_NO_LAUNCH_VALUE,
  };
}

/**
 * The human-readable directive seeded into the agent's config / prompt so it
 * does not launch its own browser (FR-B2). First-class agents honor the
 * {@link SESSION_BROWSER_NO_LAUNCH_ENV} env; generic agents get this string.
 */
export const doNotLaunchBrowserInstruction = DO_NOT_LAUNCH_BROWSER_INSTRUCTION;
