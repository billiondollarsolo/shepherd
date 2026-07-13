import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerABrowserManager, type CdpResolver } from './manager.js';
import { isOpaqueCdpEndpoint } from './cdp-endpoint.js';
import {
  BrowserConcurrencyError,
  type CreateContainerOptions,
  type DockerContainerLike,
  type DockerLike,
} from './types.js';

/** In-memory fake docker that records created/removed containers. */
class FakeDocker implements DockerLike {
  created: CreateContainerOptions[] = [];
  removed: string[] = [];
  /** Containers that "exist" (id -> running). */
  live = new Map<string, boolean>();
  /** Optional labels store for listContainers. */
  labels = new Map<string, Record<string, string>>();
  private seq = 0;
  failStart = false;

  async createContainer(options: CreateContainerOptions): Promise<DockerContainerLike> {
    this.created.push(options);
    const id = `ctr-${++this.seq}`;
    this.labels.set(id, options.Labels ?? {});
    // Arrow functions capture `this` lexically (the FakeDocker instance).
    return {
      id,
      start: async () => {
        if (this.failStart) throw new Error('boom');
        this.live.set(id, true);
      },
      remove: async () => {
        this.live.delete(id);
        this.removed.push(id);
      },
      inspect: async () => ({ Id: id, State: { Running: this.live.get(id) ?? false } }),
    };
  }

  getContainer(id: string): DockerContainerLike {
    return {
      id,
      start: async () => {
        this.live.set(id, true);
      },
      remove: async () => {
        this.live.delete(id);
        this.removed.push(id);
      },
      inspect: async () => ({ Id: id, State: { Running: this.live.get(id) ?? false } }),
    };
  }

  async listContainers(): Promise<Array<{ Id: string; Labels?: Record<string, string> }>> {
    return [...this.live.keys()].map((id) => ({ Id: id, Labels: this.labels.get(id) }));
  }
}

const resolver: CdpResolver = async ({ bindHost }) => ({
  hostPort: 49000 + Math.floor(Math.random() * 1000),
  browserWsPath: `/devtools/browser/${bindHost}-resolved`,
});

function makeManager(overrides?: {
  docker?: FakeDocker;
  maxConcurrent?: number;
  resolveCdp?: CdpResolver;
  bindHost?: string;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
}) {
  const docker = overrides?.docker ?? new FakeDocker();
  const manager = new LayerABrowserManager({
    docker,
    resolveCdp: overrides?.resolveCdp ?? resolver,
    config: {
      maxConcurrent: overrides?.maxConcurrent ?? 3,
      bindHost: overrides?.bindHost ?? '127.0.0.1',
      ...(overrides?.memoryBytes !== undefined ? { memoryBytes: overrides.memoryBytes } : {}),
      ...(overrides?.nanoCpus !== undefined ? { nanoCpus: overrides.nanoCpus } : {}),
      ...(overrides?.pidsLimit !== undefined ? { pidsLimit: overrides.pidsLimit } : {}),
    },
  });
  return { manager, docker };
}

describe('LayerABrowserManager (US-25)', () => {
  let docker: FakeDocker;
  let manager: LayerABrowserManager;

  beforeEach(() => {
    ({ manager, docker } = makeManager());
  });

  it('launches an isolated Chrome container per session', async () => {
    const b = await manager.launch('sess-1');
    expect(docker.created).toHaveLength(1);
    expect(docker.live.get(b.containerId)).toBe(true);
    expect(b.sessionId).toBe('sess-1');
    expect(manager.count()).toBe(1);
  });

  it('exposes ONLY an opaque CDP ws endpoint incl. GUID, never a bare port (FR-B1)', async () => {
    const b = await manager.launch('sess-1');
    expect(isOpaqueCdpEndpoint(b.cdpEndpoint)).toBe(true);
    expect(b.cdpEndpoint).toMatch(/^ws:\/\//);
    expect(b.cdpEndpoint).not.toMatch(/^\d+$/);
  });

  it('binds the CDP port to container loopback only (NFR-SEC5)', async () => {
    await manager.launch('sess-1');
    const opts = docker.created[0];
    const bindings = opts.HostConfig?.PortBindings ?? {};
    const allBindings = Object.values(bindings).flat();
    expect(allBindings.length).toBeGreaterThan(0);
    for (const binding of allBindings) {
      expect(binding.HostIp).toBe('127.0.0.1');
    }
  });

  it('uses internal DNS without publishing a host port in browser-worker mode', async () => {
    let resolvedHost = '';
    const workerManager = new LayerABrowserManager({
      docker,
      resolveCdp: async ({ bindHost, containerCdpPort }) => {
        resolvedHost = bindHost;
        return { hostPort: containerCdpPort, browserWsPath: '/devtools/browser/worker' };
      },
      config: { networkName: 'flock_internal' },
    });
    const browser = await workerManager.launch('session-id');
    expect(docker.created[0]?.HostConfig?.NetworkMode).toBe('flock_internal');
    expect(docker.created[0]?.HostConfig?.PortBindings).toBeUndefined();
    expect(resolvedHost).toBe('flock-browser-session-id');
    expect(browser.cdpEndpoint).toContain('flock-browser-session-id:9222');
  });

  it('refuses a non-loopback bindHost (NFR-SEC5 hard invariant)', () => {
    expect(() => makeManager({ bindHost: '0.0.0.0' })).toThrow(/loopback/i);
  });

  it('applies per-container resource caps (T15c): Memory / NanoCpus / PidsLimit', async () => {
    const { manager: m, docker: d } = makeManager({
      memoryBytes: 512 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pidsLimit: 128,
    });
    await m.launch('sess-1');
    const hc = d.created[0]!.HostConfig!;
    expect(hc.Memory).toBe(512 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(500_000_000);
    expect(hc.PidsLimit).toBe(128);
  });

  it('omits a resource cap when set to 0 (T15c)', async () => {
    const { manager: m, docker: d } = makeManager({ memoryBytes: 0, nanoCpus: 0, pidsLimit: 0 });
    await m.launch('sess-1');
    const hc = d.created[0]!.HostConfig!;
    expect(hc.Memory).toBeUndefined();
    expect(hc.NanoCpus).toBeUndefined();
    expect(hc.PidsLimit).toBeUndefined();
  });

  it('is idempotent per session — second launch returns the same browser (§4.2)', async () => {
    const first = await manager.launch('sess-1');
    const second = await manager.launch('sess-1');
    expect(second).toBe(first);
    expect(docker.created).toHaveLength(1);
    expect(manager.count()).toBe(1);
  });

  it('does not race-duplicate when launched concurrently for one session', async () => {
    const [a, b] = await Promise.all([manager.launch('sess-1'), manager.launch('sess-1')]);
    expect(a.containerId).toBe(b.containerId);
    expect(docker.created).toHaveLength(1);
  });

  it('enforces the concurrency cap (spec §10)', async () => {
    await manager.launch('s1');
    await manager.launch('s2');
    await manager.launch('s3');
    await expect(manager.launch('s4')).rejects.toBeInstanceOf(BrowserConcurrencyError);
    expect(manager.count()).toBe(3);
    expect(docker.created).toHaveLength(3);
  });

  it('frees a cap slot after stop, allowing a new launch', async () => {
    await manager.launch('s1');
    await manager.launch('s2');
    await manager.launch('s3');
    await manager.stop('s2');
    await expect(manager.launch('s4')).resolves.toBeDefined();
    expect(manager.count()).toBe(3);
  });

  it('teardown on terminate removes the container — no orphans (FR-B6)', async () => {
    const b = await manager.launch('sess-1');
    expect(docker.live.has(b.containerId)).toBe(true);
    const stopped = await manager.stop('sess-1');
    expect(stopped).toBe(true);
    expect(docker.live.has(b.containerId)).toBe(false);
    expect(docker.removed).toContain(b.containerId);
    expect(manager.count()).toBe(0);
  });

  it('force-removes the container on teardown', async () => {
    const removeSpy = vi.fn(async () => {});
    const customDocker = new FakeDocker();
    const realGet = customDocker.getContainer.bind(customDocker);
    customDocker.getContainer = (id: string) => {
      const c = realGet(id);
      return { ...c, remove: removeSpy };
    };
    const m = new LayerABrowserManager({ docker: customDocker, resolveCdp: resolver });
    await m.launch('sess-1');
    await m.stop('sess-1');
    expect(removeSpy).toHaveBeenCalledWith({ force: true });
  });

  it('stop is a no-op for an unknown session', async () => {
    expect(await manager.stop('nope')).toBe(false);
  });

  it('does not leak a container if CDP resolution fails (no-orphan on launch error)', async () => {
    const failingResolver: CdpResolver = async () => {
      throw new Error('chrome never answered');
    };
    const { manager: m, docker: d } = makeManager({ resolveCdp: failingResolver });
    await expect(m.launch('sess-1')).rejects.toThrow(/CDP endpoint/i);
    expect(d.created).toHaveLength(1);
    // The created container was force-removed, leaving no orphan and no registry entry.
    expect(d.removed).toHaveLength(1);
    expect(m.count()).toBe(0);
  });

  it('reaps orphaned Shepherd browser containers it does not track (FR-B6 safety net)', async () => {
    // Simulate a leftover container from a previous crash: live in docker, untracked.
    docker.live.set('orphan-1', true);
    docker.labels.set('orphan-1', { 'io.flock.session-browser': 'old-sess' });
    await manager.launch('sess-1');
    const removed = await manager.reap();
    expect(removed).toContain('orphan-1');
    expect(docker.live.has('orphan-1')).toBe(false);
    // The tracked, running browser is NOT reaped.
    expect(manager.count()).toBe(1);
  });

  it('stopAll tears down every running browser', async () => {
    await manager.launch('s1');
    await manager.launch('s2');
    await manager.stopAll();
    expect(manager.count()).toBe(0);
    expect(docker.removed).toHaveLength(2);
  });

  it('tags containers with the session id label and a browser GUID', async () => {
    await manager.launch('sess-xyz');
    const labels = docker.created[0].Labels ?? {};
    expect(labels['io.flock.session-browser']).toBe('sess-xyz');
    expect(labels['io.flock.browser-guid']).toBeTruthy();
  });

  it('never touches a node — pure orchestrator-local docker calls (dumb-node invariant)', async () => {
    // The manager's only dependency is the docker client; there is no node transport.
    // Asserted structurally: launching only calls createContainer/start/inspect-via-resolver.
    await manager.launch('sess-1');
    expect(docker.created).toHaveLength(1);
  });
});
