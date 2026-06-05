import type { DockerLike } from './types.js';
import type { CdpResolver } from './manager.js';

/**
 * Default {@link CdpResolver} backed by docker inspect + chrome's `/json/version`.
 *
 * After a container starts, docker assigns an ephemeral host port for the loopback
 * publish. We read it back from `inspect()` and then ask chrome for its own
 * `webSocketDebuggerUrl` so the opaque endpoint carries chrome's real browser GUID
 * path (not just our minted one). Both steps are retried briefly while chrome boots.
 */
export function createDockerCdpResolver(docker: DockerLike): CdpResolver {
  return async ({ containerId, bindHost, containerCdpPort }) => {
    const hostPort = await resolveHostPort({
      docker,
      containerId,
      containerCdpPort,
    });
    const browserWsPath = await resolveChromeWsPath({ bindHost, hostPort });
    return { hostPort, browserWsPath };
  };
}

interface InspectShape {
  NetworkSettings?: {
    Ports?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >;
  };
}

async function resolveHostPort(params: {
  docker: DockerLike;
  containerId: string;
  containerCdpPort: number;
}): Promise<number> {
  const { docker, containerId, containerCdpPort } = params;
  const key = `${containerCdpPort}/tcp`;
  const deadline = Date.now() + 5000;
  let lastErr = '';
  while (Date.now() < deadline) {
    const container = docker.getContainer(containerId);
    const info = (await container.inspect()) as unknown as InspectShape;
    const bindings = info.NetworkSettings?.Ports?.[key];
    // Prefer a loopback binding; never accept a 0.0.0.0 binding (NFR-SEC5).
    const loopback = bindings?.find(
      (b) => b.HostIp === '127.0.0.1' || b.HostIp === 'localhost',
    );
    const hostPortStr = loopback?.HostPort;
    if (hostPortStr) {
      const port = Number.parseInt(hostPortStr, 10);
      if (Number.isFinite(port) && port > 0) return port;
    }
    lastErr = `no loopback host port mapped for ${key}`;
    await sleep(150);
  }
  throw new Error(lastErr || `host port for ${key} not found`);
}

async function resolveChromeWsPath(params: {
  bindHost: string;
  hostPort: number;
}): Promise<string | undefined> {
  const { bindHost, hostPort } = params;
  const url = `http://${bindHost}:${hostPort}/json/version`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        const wsUrl = body.webSocketDebuggerUrl;
        if (wsUrl) {
          try {
            return new URL(wsUrl).pathname;
          } catch {
            // Fall through to the minted-GUID path.
          }
        }
        return undefined;
      }
    } catch {
      // chrome not up yet — retry.
    }
    await sleep(200);
  }
  // Chrome reachable check failed; let the caller fall back to the minted GUID path.
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
