/**
 * Layer A — isolated Chrome container per session (US-25).
 *
 * One Chrome container is launched ON THE ORCHESTRATOR VPS per session, bound to
 * container loopback. The only thing ever exposed for a session is an *opaque* CDP
 * WebSocket endpoint — a full `ws://` URL containing an unguessable GUID — never a
 * bare port (FR-B1, NFR-SEC5).
 *
 * Nodes stay 100% dumb: nothing here touches a node. The browser lifecycle lives
 * entirely on the orchestrator (spec §4 "Browser location", PRD §6.4).
 */

/** Describes a launched, isolated Chrome container for exactly one session. */
export interface SessionBrowser {
  /** The single authoritative session id this browser is bound to (spec §4.2 invariant). */
  readonly sessionId: string;
  /** dockerode container id of the launched Chrome container. */
  readonly containerId: string;
  /**
   * The opaque per-session CDP WebSocket endpoint: a full `ws://` URL that includes
   * an unguessable GUID. This is what gets injected as `SESSION_BROWSER_CDP` (US-26)
   * and mirrored onto the session record's `browser_cdp_endpoint` column (spec §6).
   *
   * NEVER a bare port — always the full ws URL with the GUID path.
   */
  readonly cdpEndpoint: string;
  /** When the container was launched. */
  readonly startedAt: Date;
}

/**
 * Minimal slice of the dockerode `Container` we depend on, so the manager can be
 * unit-tested against a fake without docker present.
 */
export interface DockerContainerLike {
  readonly id: string;
  start(): Promise<unknown>;
  /** Force-remove the container (used for teardown / no-orphans guarantee). */
  remove(options?: { force?: boolean }): Promise<unknown>;
  inspect(): Promise<{
    Id: string;
    State?: { Running?: boolean };
  }>;
}

/** Options handed to docker when creating the Chrome container. */
export interface CreateContainerOptions {
  Image: string;
  name?: string;
  Cmd?: string[];
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Env?: string[];
  HostConfig?: {
    /**
     * Port bindings. For loopback-only exposure every HostIp MUST be 127.0.0.1
     * (NFR-SEC5: the container's CDP port is reachable only from the orchestrator host).
     */
    PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    AutoRemove?: boolean;
    Init?: boolean;
    /** chrome's headless sandbox needs extra shm; keep it modest but explicit. */
    ShmSize?: number;
    /** T15(c) — hard memory cap in bytes (Docker `Memory`). */
    Memory?: number;
    /** T15(c) — CPU cap in nano-CPUs (1e9 = 1 vCPU; Docker `NanoCpus`). */
    NanoCpus?: number;
    /** T15(c) — max PIDs in the container (fork-bomb guard; Docker `PidsLimit`). */
    PidsLimit?: number;
    /** Dedicated internal network used by the constrained browser worker. */
    NetworkMode?: string;
  };
}

/**
 * Minimal slice of the dockerode `Docker` client we depend on.
 */
export interface DockerLike {
  createContainer(options: CreateContainerOptions): Promise<DockerContainerLike>;
  getContainer(id: string): DockerContainerLike;
  /** Used by reap() to find leftover Flock browser containers (no-orphan sweep). */
  listContainers(options: {
    all?: boolean;
    filters?: Record<string, string[]>;
  }): Promise<Array<{ Id: string; Labels?: Record<string, string> }>>;
}

export interface LayerAConfig {
  /** Docker image for the per-session Chrome (headless, CDP enabled). */
  readonly image: string;
  /** Hard cap on concurrently running session browsers (spec §10, FR-B / NFR). */
  readonly maxConcurrent: number;
  /** Host IP every CDP port binds to. MUST be loopback (default 127.0.0.1). */
  readonly bindHost: string;
  /** Port chrome listens on inside the container. */
  readonly containerCdpPort: number;
  /** Label key used to tag/reap Flock-managed browser containers. */
  readonly labelKey: string;
  /**
   * T15(c) — per-container resource caps so one heavy page can't OOM/peg the host.
   * `memoryBytes` → Docker `Memory`; `nanoCpus` → `NanoCpus` (1e9 = 1 vCPU);
   * `pidsLimit` → `PidsLimit` (fork-bomb guard). 0/undefined leaves that limit unset.
   */
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  /** When set, connect by container DNS on this network instead of publishing a host port. */
  readonly networkName?: string;
}

export const DEFAULT_LAYER_A_CONFIG: LayerAConfig = {
  image: 'flock/session-chrome:latest',
  maxConcurrent: 10,
  bindHost: '127.0.0.1',
  containerCdpPort: 9222,
  labelKey: 'io.flock.session-browser',
  // Sensible defaults for a headless Chrome rendering one page: 1 GiB RAM, 1 vCPU,
  // 512 PIDs. Tunable via env in the orchestrator wiring.
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 512,
};

/** Thrown when launching would exceed the concurrency cap (spec §10 edge case). */
export class BrowserConcurrencyError extends Error {
  readonly code = 'BROWSER_CONCURRENCY_CAP';
  constructor(public readonly cap: number) {
    super(`Session browser concurrency cap reached (max ${cap})`);
    this.name = 'BrowserConcurrencyError';
  }
}

/** Thrown when a CDP endpoint cannot be resolved from a launched container. */
export class BrowserLaunchError extends Error {
  readonly code = 'BROWSER_LAUNCH_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'BrowserLaunchError';
  }
}
