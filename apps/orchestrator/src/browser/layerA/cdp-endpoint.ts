import { randomUUID } from 'node:crypto';

/**
 * The opaque CDP endpoint for a session browser.
 *
 * Security requirement (FR-B1, NFR-SEC5, spec §6.5 / US-26): what we hand out is a
 * full `ws://` URL containing an unguessable GUID — NEVER a bare port. Even though the
 * port is loopback-bound on the orchestrator, the GUID is the capability that scopes
 * access to exactly one session.
 */
export interface OpaqueCdpEndpoint {
  /** Unguessable GUID embedded in the ws path; scopes the capability to one session. */
  readonly guid: string;
  /** The loopback host:port the chrome CDP port is bound to on the orchestrator. */
  readonly host: string;
  readonly port: number;
  /** Full ws URL incl. GUID path. This is the value injected / persisted. */
  readonly url: string;
}

/** Generate a fresh unguessable GUID for a session browser endpoint. */
export function newBrowserGuid(): string {
  return randomUUID();
}

/**
 * Build the opaque CDP ws URL.
 *
 * The GUID is placed on the path so the value is self-describing as a capability and
 * is never just `ws://host:port`. CDP's own per-target GUID path
 * (`/devtools/browser/<id>`) is preserved by appending it when known; otherwise the
 * Flock-minted GUID stands in so the value is still opaque and not a bare port.
 */
export function buildCdpEndpoint(params: {
  host: string;
  port: number;
  guid: string;
  /** chrome's own browser webSocketDebuggerUrl path, if already discovered. */
  browserWsPath?: string;
}): OpaqueCdpEndpoint {
  const { host, port, guid, browserWsPath } = params;
  const path = browserWsPath ?? `/devtools/browser/${guid}`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return {
    guid,
    host,
    port,
    url: `ws://${host}:${port}${normalizedPath}`,
  };
}

/**
 * True iff the value is a full ws/wss URL with a non-empty path — i.e. NOT a bare
 * port and NOT a bare `host:port` authority. Used to assert the FR-B1 contract.
 */
export function isOpaqueCdpEndpoint(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Reject anything that is just digits (a bare port) up front.
  if (/^\d+$/.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  // Must carry an opaque path component beyond "/".
  return parsed.pathname.length > 1;
}
