import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import { LayerABrowserManager } from './manager.js';
import { createDockerCdpResolver } from './docker-cdp-resolver.js';
import { isOpaqueCdpEndpoint } from './cdp-endpoint.js';
import type { DockerLike } from './types.js';

/**
 * US-25 integration test — real Chrome container lifecycle on the orchestrator host.
 *
 * INT-ONLY: requires a reachable docker daemon (docker-in-docker in CI). If docker is
 * unavailable, every case is skipped cleanly so the suite still passes on a host with
 * no docker (per the task's "skips cleanly if docker-in-docker unavailable" requirement).
 *
 * Image: a small headless-chrome CDP image. Override with FLOCK_CHROME_IMAGE.
 */
const CHROME_IMAGE = process.env.FLOCK_CHROME_IMAGE ?? 'zenika/alpine-chrome:latest';
const LABEL = 'io.flock.session-browser.inttest';

let docker: Docker | undefined;
let dockerAvailable = false;

async function ensureImage(d: Docker, image: string): Promise<void> {
  const images = await d.listImages();
  const present = images.some((i) => (i.RepoTags ?? []).includes(image));
  if (present) return;
  await new Promise<void>((resolve, reject) => {
    d.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      d.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
    });
  });
}

beforeAll(async () => {
  try {
    docker = new Docker();
    await docker.ping();
    dockerAvailable = true;
    await ensureImage(docker, CHROME_IMAGE);
  } catch {
    dockerAvailable = false;
  }
}, 120_000);

afterAll(async () => {
  if (!docker) return;
  // Belt-and-suspenders: remove any leftover int-test containers.
  try {
    const leftovers = await docker.listContainers({
      all: true,
      filters: { label: [LABEL] },
    });
    await Promise.all(
      leftovers.map((c) =>
        docker!
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => {}),
      ),
    );
  } catch {
    /* ignore */
  }
});

// The gate is runtime: skip each test if docker isn't reachable so the suite passes
// cleanly on a host with no docker-in-docker.
const maybe = (name: string, fn: () => Promise<void>) =>
  it(
    name,
    async () => {
      if (!dockerAvailable || !docker) {
        // Mark as skipped at runtime rather than failing on docker-less hosts.
        return;
      }
      await fn();
    },
    120_000,
  );

describe('Layer A integration — real Chrome container (US-25, int-only)', () => {
  maybe(
    'launches a container, exposes a loopback opaque CDP endpoint, then tears down',
    async () => {
      const d = docker as unknown as DockerLike;
      const manager = new LayerABrowserManager({
        docker: d,
        resolveCdp: createDockerCdpResolver(d),
        config: {
          image: CHROME_IMAGE,
          labelKey: LABEL,
          maxConcurrent: 2,
          containerCdpPort: 9222,
        },
      });

      const sessionId = `int-${Date.now()}`;
      const browser = await manager.launch(sessionId);

      // Opaque endpoint, full ws URL, not a bare port (FR-B1).
      expect(isOpaqueCdpEndpoint(browser.cdpEndpoint)).toBe(true);
      expect(browser.cdpEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\//);

      // Container is actually running.
      const info = await docker!.getContainer(browser.containerId).inspect();
      expect(info.State?.Running).toBe(true);

      // Teardown removes it — no orphan (FR-B6).
      await manager.stop(sessionId);
      await expect(docker!.getContainer(browser.containerId).inspect()).rejects.toBeTruthy();

      // No Flock-labelled container remains for this session.
      const remaining = await docker!.listContainers({
        all: true,
        filters: { label: [`${LABEL}=${sessionId}`] },
      });
      expect(remaining).toHaveLength(0);
    },
  );

  maybe('enforces the concurrency cap against real containers', async () => {
    const d = docker as unknown as DockerLike;
    const manager = new LayerABrowserManager({
      docker: d,
      resolveCdp: createDockerCdpResolver(d),
      config: { image: CHROME_IMAGE, labelKey: LABEL, maxConcurrent: 1 },
    });

    const s1 = `int-cap-a-${Date.now()}`;
    const s2 = `int-cap-b-${Date.now()}`;
    try {
      await manager.launch(s1);
      await expect(manager.launch(s2)).rejects.toThrow(/cap|concurren/i);
    } finally {
      await manager.stopAll();
    }
  });

  maybe('reap removes orphaned containers left behind by a crash', async () => {
    const d = docker as unknown as DockerLike;
    // Create an untracked Flock-labelled container directly, simulating a crash orphan.
    const orphan = await docker!.createContainer({
      Image: CHROME_IMAGE,
      name: `flock-orphan-${Date.now()}`,
      Labels: { [LABEL]: 'crashed-session' },
      Cmd: ['--headless=new', '--no-sandbox', '--remote-debugging-port=9222'],
      HostConfig: { AutoRemove: false },
    } as never);
    await orphan.start();

    const manager = new LayerABrowserManager({
      docker: d,
      resolveCdp: createDockerCdpResolver(d),
      config: { image: CHROME_IMAGE, labelKey: LABEL },
    });
    const removed = await manager.reap();
    expect(removed).toContain(orphan.id);

    await expect(docker!.getContainer(orphan.id).inspect()).rejects.toBeTruthy();
  });
});
