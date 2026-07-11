import { z } from 'zod';

/**
 * Layer B — agent-driving via an injected opaque CDP endpoint (US-26, FR-B2,
 * spec §6.5 "Layer B").
 *
 * The orchestrator launches one isolated Chrome container per session (Layer A,
 * US-25) and threads its CDP endpoint through the SINGLE authoritative session
 * record (`Session.browserCdpEndpoint`, spec §4.2). For the agent to *drive*
 * that browser, the endpoint is injected into the session's environment as
 * `SESSION_BROWSER_CDP`, and the agent is instructed NOT to launch its own
 * browser.
 *
 * Two hard requirements from the spec/PRD, asserted by tests:
 *  1. The injected value is a FULL ws URL that INCLUDES an unguessable GUID and
 *     is NEVER a bare port (PRD §6.5 Layer B: "full ws URL incl. unguessable
 *     GUID — never a bare port"). Isolation is enforced by the unguessable GUID
 *     path, not by an exposed numeric port the agent could scan/guess.
 *  2. v1 ships native/MCP driving as the Layer B mechanism; the editable
 *     browser-harness is deferred until the US-0b spike clears
 *     (docs/decisions/browser-driving.md).
 *
 * This module is shared (imported by BOTH apps): the orchestrator builds the
 * injected env; the web app may surface "agent is driving the session browser"
 * UI keyed off the same constant. No type is duplicated.
 */

// ---------------------------------------------------------------------------
// The injected env var name (single source of truth — never re-typed elsewhere)
// ---------------------------------------------------------------------------

/**
 * The env var the agent reads to attach to its session's browser over CDP.
 * Its value is the opaque ws URL (see {@link OpaqueCdpEndpoint}).
 */
export const SESSION_BROWSER_CDP_ENV = 'SESSION_BROWSER_CDP' as const;

/**
 * The env var that tells first-class agents NOT to spawn their own browser
 * (they must attach to {@link SESSION_BROWSER_CDP_ENV} instead). Generic agents
 * additionally get the human-readable {@link DO_NOT_LAUNCH_BROWSER_INSTRUCTION}.
 */
export const SESSION_BROWSER_NO_LAUNCH_ENV = 'SESSION_BROWSER_NO_LAUNCH' as const;

/** Value of {@link SESSION_BROWSER_NO_LAUNCH_ENV} when the directive is active. */
export const SESSION_BROWSER_NO_LAUNCH_VALUE = '1' as const;

/**
 * The Layer B driving mechanism for v1. `native-mcp` = the agent drives via its
 * own native browser tooling / MCP over the injected CDP endpoint. `harness` is
 * the editable browser-harness, gated behind the US-0b spike and NOT shipped in
 * v1 (docs/decisions/browser-driving.md).
 */
export const LayerBMechanismEnum = z.enum(['native-mcp', 'harness']);
export type LayerBMechanism = z.infer<typeof LayerBMechanismEnum>;

/** The v1 default Layer B mechanism (browser-harness deferred, US-0b). */
export const LAYER_B_MECHANISM_V1: LayerBMechanism = 'native-mcp';

/**
 * The instruction handed to the agent so it does not launch its own browser
 * (FR-B2). First-class agents honor {@link SESSION_BROWSER_NO_LAUNCH_ENV}; this
 * string is the generic/fallback directive and is referenced verbatim in the
 * seeded agent config / prompt.
 */
export const DO_NOT_LAUNCH_BROWSER_INSTRUCTION: string =
  `A browser is already running for this session. Do NOT launch your own browser. ` +
  `Connect over CDP to the endpoint in the ${SESSION_BROWSER_CDP_ENV} environment ` +
  `variable (a WebSocket DevTools URL) and drive that browser.`;

// ---------------------------------------------------------------------------
// Opaque endpoint validation (GUID present, no bare port)
// ---------------------------------------------------------------------------

/**
 * A v4-style GUID as it appears in a CDP DevTools ws path
 * (e.g. `/devtools/browser/<guid>`). Hyphenated 8-4-4-4-12 hex.
 */
export const CDP_GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Matches a "bare port" leak: a `:<digits>` authority component, e.g.
 * `ws://127.0.0.1:9222/...`. The opaque agent-facing endpoint must NOT contain
 * one — isolation rides the unguessable GUID, not a guessable numeric port.
 *
 * Anchored to the authority: it matches a colon-then-digits that is followed by
 * a path/query/fragment delimiter or end of string, so a digit appearing only
 * inside the path (e.g. the GUID) is never mistaken for a port.
 */
export const BARE_PORT_RE = /^[a-z]+:\/\/[^/?#]*:\d+(?:[/?#]|$)/i;

/** Matches the ws:// or wss:// scheme prefix. */
const WS_SCHEME_RE = /^wss?:\/\//i;

/**
 * The opaque CDP endpoint injected into the agent env. It is a ws/wss URL whose
 * path carries an unguessable GUID and whose authority exposes NO bare port.
 *
 * Validated with pure string parsing (no `URL` global) so this contract stays
 * lib-agnostic and importable by BOTH apps. Refinements (each a distinct,
 * testable failure mode):
 *  - must use the ws:// or wss:// scheme;
 *  - must contain a GUID somewhere in the URL (the path);
 *  - must NOT contain a bare `:port` authority component.
 */
export const OpaqueCdpEndpoint = z
  .string()
  .url()
  .superRefine((val, ctx) => {
    if (!WS_SCHEME_RE.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint must use the ws:// or wss:// protocol',
      });
    }
    if (!CDP_GUID_RE.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint must carry an unguessable GUID in its path',
      });
    }
    if (BARE_PORT_RE.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint must be opaque — no bare port may be exposed',
      });
    }
  });
export type OpaqueCdpEndpoint = z.infer<typeof OpaqueCdpEndpoint>;

/** True iff `value` is a valid opaque CDP endpoint (GUID present, no bare port). */
export function isOpaqueCdpEndpoint(value: string): boolean {
  return OpaqueCdpEndpoint.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// The injected env contract
// ---------------------------------------------------------------------------

/**
 * The Layer B environment injected into a session (FR-B2). Validated so any
 * producer (the orchestrator) and any consumer agree on the exact shape:
 * `SESSION_BROWSER_CDP` is an opaque CDP endpoint and the no-launch directive
 * is set.
 */
export const LayerBSessionEnv = z.object({
  [SESSION_BROWSER_CDP_ENV]: OpaqueCdpEndpoint,
  [SESSION_BROWSER_NO_LAUNCH_ENV]: z.literal(SESSION_BROWSER_NO_LAUNCH_VALUE),
});
export type LayerBSessionEnv = z.infer<typeof LayerBSessionEnv>;
