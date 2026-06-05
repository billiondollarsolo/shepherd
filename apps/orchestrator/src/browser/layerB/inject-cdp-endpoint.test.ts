import { describe, expect, it } from 'vitest';
import {
  BARE_PORT_RE,
  LAYER_B_MECHANISM_V1,
  LayerBSessionEnv,
  SESSION_BROWSER_CDP_ENV,
  SESSION_BROWSER_NO_LAUNCH_ENV,
  SESSION_BROWSER_NO_LAUNCH_VALUE,
} from '@flock/shared';
import {
  buildLayerBSessionEnv,
  opaqueCdpEndpointForSession,
} from './inject-cdp-endpoint.js';

/**
 * US-26 — Layer B agent-driving via injected endpoint (FR-B2, spec §6.5).
 *
 * Unit-tests (per the implementation note) that the endpoint is OPAQUE — GUID
 * present, no bare port — and is INJECTED into the session env, and that the
 * agent is told not to launch its own browser. Pure-function tests; the
 * orchestrator stays the brain and nodes stay dumb couriers.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/** Minimal authoritative-session shape the builder reads (mirror of the record). */
function session(overrides: Partial<{ id: string; browserCdpEndpoint: string | null }> = {}) {
  return {
    id: SESSION_ID,
    browserCdpEndpoint: opaqueCdpEndpointForSession(SESSION_ID),
    ...overrides,
  };
}

describe('opaqueCdpEndpointForSession', () => {
  it('produces a ws URL that embeds the session_id GUID and no bare port', () => {
    const endpoint = opaqueCdpEndpointForSession(SESSION_ID);
    expect(endpoint).toContain(SESSION_ID); // §4.2: same session_id threads the endpoint
    expect(endpoint.startsWith('ws://')).toBe(true);
    expect(BARE_PORT_RE.test(endpoint)).toBe(false); // opaque — no bare port
  });
});

describe('buildLayerBSessionEnv (FR-B2)', () => {
  it('injects SESSION_BROWSER_CDP with the opaque endpoint', () => {
    const env = buildLayerBSessionEnv(session());
    expect(env[SESSION_BROWSER_CDP_ENV]).toBeDefined();
    expect(env[SESSION_BROWSER_CDP_ENV]).toBe(session().browserCdpEndpoint);
  });

  it('the injected endpoint contains the GUID and never a bare port (opaque)', () => {
    const env = buildLayerBSessionEnv(session());
    const value = env[SESSION_BROWSER_CDP_ENV]!;
    expect(value).toContain(SESSION_ID); // GUID present
    expect(BARE_PORT_RE.test(value)).toBe(false); // no bare port
    // It also satisfies the full shared opaque contract.
    expect(LayerBSessionEnv.safeParse(env).success).toBe(true);
  });

  it('sets the no-launch directive so the agent does not start its own browser', () => {
    const env = buildLayerBSessionEnv(session());
    expect(env[SESSION_BROWSER_NO_LAUNCH_ENV]).toBe(SESSION_BROWSER_NO_LAUNCH_VALUE);
  });

  it('derives the endpoint from the SAME session_id (single-record invariant §4.2)', () => {
    // The endpoint injected must be the one bound on the authoritative record,
    // and it must carry that record's id — not some other session's.
    const rec = session();
    const env = buildLayerBSessionEnv(rec);
    expect(env[SESSION_BROWSER_CDP_ENV]).toBe(rec.browserCdpEndpoint);
    expect(env[SESSION_BROWSER_CDP_ENV]).toContain(rec.id);
  });

  it('returns an empty env (no injection) when no browser is bound yet', () => {
    const env = buildLayerBSessionEnv(session({ browserCdpEndpoint: null }));
    expect(env[SESSION_BROWSER_CDP_ENV]).toBeUndefined();
    expect(env[SESSION_BROWSER_NO_LAUNCH_ENV]).toBeUndefined();
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('throws if the bound endpoint is not opaque (defends the no-bare-port rule)', () => {
    const leaky = `ws://127.0.0.1:9222/devtools/browser/${SESSION_ID}`;
    expect(() => buildLayerBSessionEnv(session({ browserCdpEndpoint: leaky }))).toThrow();
  });

  it('v1 ships native/MCP driving as the Layer B mechanism', () => {
    expect(LAYER_B_MECHANISM_V1).toBe('native-mcp');
  });
});
