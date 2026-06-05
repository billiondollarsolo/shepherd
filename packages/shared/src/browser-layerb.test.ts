import { describe, expect, it } from 'vitest';
import {
  BARE_PORT_RE,
  CDP_GUID_RE,
  DO_NOT_LAUNCH_BROWSER_INSTRUCTION,
  LAYER_B_MECHANISM_V1,
  LayerBMechanismEnum,
  LayerBSessionEnv,
  OpaqueCdpEndpoint,
  SESSION_BROWSER_CDP_ENV,
  SESSION_BROWSER_NO_LAUNCH_ENV,
  SESSION_BROWSER_NO_LAUNCH_VALUE,
  isOpaqueCdpEndpoint,
} from './index.js';

/**
 * US-26 — Layer B agent-driving via injected endpoint (FR-B2, spec §6.5).
 *
 * The agent-facing CDP endpoint must be OPAQUE: a full ws URL carrying an
 * unguessable GUID, and NEVER a bare port (PRD §6.5 Layer B). These tests pin
 * that contract in the shared package so both apps agree on it.
 */

const GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OPAQUE = `ws://flock-browser/devtools/browser/${GUID}`;

describe('OpaqueCdpEndpoint (US-26 / FR-B2)', () => {
  it('accepts a ws URL that carries a GUID and exposes no bare port', () => {
    expect(OpaqueCdpEndpoint.safeParse(OPAQUE).success).toBe(true);
    expect(isOpaqueCdpEndpoint(OPAQUE)).toBe(true);
  });

  it('rejects a bare-port endpoint even when it carries the GUID', () => {
    const barePort = `ws://127.0.0.1:9222/devtools/browser/${GUID}`;
    expect(BARE_PORT_RE.test(barePort)).toBe(true);
    expect(OpaqueCdpEndpoint.safeParse(barePort).success).toBe(false);
    expect(isOpaqueCdpEndpoint(barePort)).toBe(false);
  });

  it('rejects an endpoint with no GUID in the path', () => {
    const noGuid = 'ws://flock-browser/devtools/browser/main';
    expect(CDP_GUID_RE.test(noGuid)).toBe(false);
    expect(OpaqueCdpEndpoint.safeParse(noGuid).success).toBe(false);
  });

  it('rejects a non-ws protocol', () => {
    const http = `http://flock-browser/devtools/browser/${GUID}`;
    expect(OpaqueCdpEndpoint.safeParse(http).success).toBe(false);
  });

  it('rejects a non-URL string', () => {
    expect(OpaqueCdpEndpoint.safeParse('not-a-url').success).toBe(false);
  });
});

describe('LayerBSessionEnv contract', () => {
  it('requires the opaque CDP var and the no-launch directive', () => {
    const env = {
      [SESSION_BROWSER_CDP_ENV]: OPAQUE,
      [SESSION_BROWSER_NO_LAUNCH_ENV]: SESSION_BROWSER_NO_LAUNCH_VALUE,
    };
    expect(LayerBSessionEnv.safeParse(env).success).toBe(true);
  });

  it('rejects an env whose CDP var leaks a bare port', () => {
    const env = {
      [SESSION_BROWSER_CDP_ENV]: `ws://127.0.0.1:9222/devtools/browser/${GUID}`,
      [SESSION_BROWSER_NO_LAUNCH_ENV]: SESSION_BROWSER_NO_LAUNCH_VALUE,
    };
    expect(LayerBSessionEnv.safeParse(env).success).toBe(false);
  });
});

describe('Layer B mechanism (v1 = native/MCP; browser-harness deferred)', () => {
  it('defaults to native-mcp for v1 (US-0b not cleared)', () => {
    expect(LAYER_B_MECHANISM_V1).toBe('native-mcp');
    expect(LayerBMechanismEnum.options).toContain('native-mcp');
    expect(LayerBMechanismEnum.options).toContain('harness');
  });
});

describe('do-not-launch directive (FR-B2)', () => {
  it('instructs the agent not to launch its own browser and names the env var', () => {
    expect(DO_NOT_LAUNCH_BROWSER_INSTRUCTION.toLowerCase()).toContain(
      'do not launch',
    );
    expect(DO_NOT_LAUNCH_BROWSER_INSTRUCTION).toContain(SESSION_BROWSER_CDP_ENV);
  });
});
