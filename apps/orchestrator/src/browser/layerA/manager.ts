import {
  BrowserConcurrencyError,
  BrowserLaunchError,
  DEFAULT_LAYER_A_CONFIG,
  type CreateContainerOptions,
  type DockerLike,
  type LayerAConfig,
  type SessionBrowser,
} from './types.js';
import { buildCdpEndpoint, newBrowserGuid, type OpaqueCdpEndpoint } from './cdp-endpoint.js';

/**
 * Resolves the host port docker mapped a container's CDP port to, plus chrome's own
 * `webSocketDebuggerUrl` browser path. Injected so the manager is testable without a
 * real chrome (the integration test supplies the real resolver).
 */
export type CdpResolver = (params: {
  containerId: string;
  bindHost: string;
  containerCdpPort: number;
}) => Promise<{ hostPort: number; host?: string; browserWsPath?: string }>;

export interface LayerABrowserManagerDeps {
  docker: DockerLike;
  config?: Partial<LayerAConfig>;
  /** Resolves the bound host port + chrome browser ws path for a started container. */
  resolveCdp: CdpResolver;
}

/**
 * US-25 — Layer A: one isolated Chrome container per session on the orchestrator VPS.
 *
 * Responsibilities:
 *  - launch a Chrome container per session, bound to container loopback (NFR-SEC5);
 *  - expose ONLY an opaque per-session CDP ws endpoint incl. GUID (FR-B1, never a bare port);
 *  - enforce a concurrency cap (spec §10);
 *  - teardown on terminate removes the container — no orphans (FR-B6).
 *
 * Nodes are never touched — the entire browser lifecycle is local to the orchestrator
 * (PRD §6.4 dumb-node invariant).
 */
export class LayerABrowserManager {
  private readonly docker: DockerLike;
  private readonly config: LayerAConfig;
  private readonly resolveCdp: CdpResolver;
  /** sessionId -> launched browser. The live registry of running session browsers. */
  private readonly browsers = new Map<string, SessionBrowser>();
  /** Per-session locks so concurrent launch/stop for one session can't race. */
  private readonly inflight = new Map<string, Promise<SessionBrowser>>();

  constructor(deps: LayerABrowserManagerDeps) {
    this.docker = deps.docker;
    this.resolveCdp = deps.resolveCdp;
    this.config = { ...DEFAULT_LAYER_A_CONFIG, ...deps.config };
    if (this.config.bindHost !== '127.0.0.1' && this.config.bindHost !== 'localhost') {
      // Loopback-only is a hard security invariant (NFR-SEC5). Refuse to misconfigure.
      throw new Error(`LayerA bindHost must be loopback (got "${this.config.bindHost}")`);
    }
  }

  /** Number of currently running session browsers. */
  count(): number {
    return this.browsers.size;
  }

  /** Look up a running session browser, if any. */
  get(sessionId: string): SessionBrowser | undefined {
    return this.browsers.get(sessionId);
  }

  /**
   * Launch (or return the existing) isolated Chrome container for a session.
   *
   * Idempotent per session: a second call for an already-running session returns the
   * same browser rather than launching a duplicate (the §4.2 one-session invariant).
   * Enforces the concurrency cap before creating anything.
   */
  async launch(sessionId: string): Promise<SessionBrowser> {
    if (!sessionId) throw new Error('sessionId is required');

    const existing = this.browsers.get(sessionId);
    if (existing) return existing;

    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    // Cap is checked against running + in-flight launches to avoid a thundering herd
    // blowing past the limit (spec §10 "concurrent browser container cap reached").
    if (this.browsers.size + this.inflight.size >= this.config.maxConcurrent) {
      throw new BrowserConcurrencyError(this.config.maxConcurrent);
    }

    const promise = this.doLaunch(sessionId);
    this.inflight.set(sessionId, promise);
    try {
      const browser = await promise;
      this.browsers.set(sessionId, browser);
      return browser;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  private async doLaunch(sessionId: string): Promise<SessionBrowser> {
    const guid = newBrowserGuid();
    const {
      containerCdpPort,
      bindHost,
      image,
      labelKey,
      memoryBytes,
      nanoCpus,
      pidsLimit,
      networkName,
    } = this.config;
    const portKey = `${containerCdpPort}/tcp`;
    const containerName = `flock-browser-${sessionId}`;

    const createOpts: CreateContainerOptions = {
      Image: image,
      name: containerName,
      Labels: {
        [labelKey]: sessionId,
        'io.flock.browser-guid': guid,
      },
      ExposedPorts: { [portKey]: {} },
      Cmd: [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        // Bind chrome's CDP server to all interfaces *inside the container only*; the
        // container is reachable solely via the loopback host port binding below.
        `--remote-debugging-port=${containerCdpPort}`,
        '--remote-debugging-address=0.0.0.0',
        '--remote-allow-origins=*',
      ],
      HostConfig: {
        // Loopback-only: the CDP port is published exclusively on 127.0.0.1 of the
        // orchestrator host (NFR-SEC5). No 0.0.0.0 host binding ever.
        ...(networkName
          ? { NetworkMode: networkName }
          : { PortBindings: { [portKey]: [{ HostIp: bindHost, HostPort: '0' }] } }),
        Init: true,
        ShmSize: 256 * 1024 * 1024,
        // T15(c): cap each session's Chrome so one heavy page can't OOM/peg the
        // host. 0/undefined leaves the corresponding Docker limit unset.
        ...(memoryBytes > 0 ? { Memory: memoryBytes } : {}),
        ...(nanoCpus > 0 ? { NanoCpus: nanoCpus } : {}),
        ...(pidsLimit > 0 ? { PidsLimit: pidsLimit } : {}),
      },
    };

    let containerId: string;
    try {
      const container = await this.docker.createContainer(createOpts);
      await container.start();
      containerId = container.id;
    } catch (err) {
      throw new BrowserLaunchError(
        `failed to create/start session browser: ${(err as Error).message}`,
      );
    }

    let endpoint: OpaqueCdpEndpoint;
    try {
      const { hostPort, host, browserWsPath } = await this.resolveCdp({
        containerId,
        bindHost: networkName ? containerName : bindHost,
        containerCdpPort,
      });
      endpoint = buildCdpEndpoint({
        host: host ?? (networkName ? containerName : bindHost),
        port: hostPort,
        guid,
        browserWsPath,
      });
    } catch (err) {
      // Resolution failed — do not leak the container (no-orphan guarantee, FR-B6).
      await this.forceRemove(containerId);
      throw new BrowserLaunchError(`failed to resolve CDP endpoint: ${(err as Error).message}`);
    }

    return {
      sessionId,
      containerId,
      cdpEndpoint: endpoint.url,
      startedAt: new Date(),
    };
  }

  /**
   * Stop & remove a session's browser container.
   *
   * Called on session terminate (US-13 / FR-S5). Force-removes so no orphan container
   * survives a kill (FR-B6). Idempotent: a no-op if the session has no browser.
   * Even if docker errors, the in-memory registry entry is cleared so a retry/relaunch
   * is possible and the count never over-reports.
   */
  async stop(sessionId: string): Promise<boolean> {
    const browser = this.browsers.get(sessionId);
    if (!browser) return false;
    this.browsers.delete(sessionId);
    await this.forceRemove(browser.containerId);
    return true;
  }

  /**
   * Sweep for any orphaned Shepherd browser containers (e.g. left over from an
   * orchestrator crash) and force-remove them. Returns the removed container ids.
   * Used at boot and as a safety net for the no-orphans guarantee (FR-B6).
   */
  async reap(): Promise<string[]> {
    const live = new Set([...this.browsers.values()].map((b) => b.containerId));
    let containers: Array<{ Id: string; Labels?: Record<string, string> }>;
    try {
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: [this.config.labelKey] },
      });
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const c of containers) {
      if (live.has(c.Id)) continue;
      await this.forceRemove(c.Id);
      removed.push(c.Id);
    }
    return removed;
  }

  /** Stop every running session browser (orchestrator shutdown). */
  async stopAll(): Promise<void> {
    const ids = [...this.browsers.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private async forceRemove(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force: true });
    } catch {
      // Already gone (e.g. AutoRemove) — treat as success for the no-orphan contract.
    }
  }
}
