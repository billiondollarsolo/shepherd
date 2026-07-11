/**
 * browser-channels.ts — assembles the per-session browser feature that was built
 * across `browser/layer{A,B,C}` + `browser/controls` but never wired into the
 * running app (so `BrowserPane` sat at "connecting…"). Mirrors `live-channels.ts`.
 *
 * What it wires (US-25/27):
 *   - Layer A: a per-session headless Chrome CONTAINER (dockerode) + its loopback
 *     CDP endpoint, launched ON DEMAND when the Browser tab opens.
 *   - A CDP page client (chrome-remote-interface) per session, shared by the
 *     screencast stream + (future) input takeover.
 *   - Layer C ScreencastManager: subscribes to `Page.screencastFrame` and pumps
 *     encoded frames to the `screencast:<id>` WebSocket.
 *   - `/ws/screencast/:id` (cookie-authed): client sends `{op:'open'|'close'}` to
 *     start/stop the stream and `{op:'screencast:quality'}` to adjust quality;
 *     the server streams `{channel:'screencast',type:'frame',…}` back.
 *
 * Containers are loopback-only (NFR-SEC5) and force-removed on terminate / reap
 * so none orphan (FR-B6). Docker access failures degrade gracefully: the stream
 * just never opens (the pane shows its connecting hint) rather than crashing.
 */
import type { Server as HttpServer } from 'node:http';

import Docker from 'dockerode';
import { WebSocketServer, type WebSocket } from 'ws';
import { InputIntent, type BrowserControlResponse } from '@flock/shared';

import type { AuditLogger } from './audit/index.js';
import {
  LayerABrowserManager,
  createDockerCdpResolver,
  type DockerLike,
} from './browser/layerA/index.js';
import { ScreencastManager, InputTakeoverController } from './browser/layerC/index.js';
import { BandwidthController, ScreencastEngineAdapter } from './browser/controls/index.js';
import { connectCdpPageClient, type CdpPageClient } from './browser/cdp-page-client.js';
import { attachWsHeartbeat } from './ws-heartbeat.js';
import { BrowserWorkerClient } from './browser/worker-client.js';
import type { BrowserLifecycle } from './browser/lifecycle.js';

export interface BrowserChannelsDeps {
  /**
   * Resolve the acting user id from the session cookie, or null when unauthed
   * (NFR-SEC6). The id is the screencast WS controller id (input takeover lock).
   */
  resolveUserId: (cookieHeader: string | undefined) => Promise<string | null>;
  /**
   * T4/T5: authorize the screencast WS upgrade — Origin check + the user owns the
   * session. Optional so tests can omit it (then only resolveUserId
   * gates). Returns false → the upgrade is refused.
   */
  authorizeUpgrade?: (
    req: import('node:http').IncomingMessage,
    sessionId: string,
  ) => Promise<boolean>;
  /** Writes the `browser_takeover` audit row (FR-A3). */
  audit: AuditLogger;
  /** Chrome image (default from BROWSER_IMAGE env). */
  image?: string;
  /** Max concurrent session browsers (default from BROWSER_MAX_CONCURRENT env). */
  maxConcurrent?: number;
  /** Docker socket path (default dockerode's /var/run/docker.sock). */
  dockerSocket?: string;
  /** Sink for best-effort warnings; defaults to console.warn. */
  logger?: { warn(msg: string, err: unknown): void };
  /** Injected lifecycle for tests or the production least-privilege worker. */
  lifecycle?: BrowserLifecycle;
}

export interface BrowserChannels {
  /** Attach the `/ws/screencast/:id` upgrade handler to the HTTP server. */
  attach(server: HttpServer): void;
  /** Acquire the single input-control lock for a session (US-28). */
  takeover(
    sessionId: string,
    controllerId: string,
    ip: string | null,
  ): Promise<BrowserControlResponse>;
  /** Release the input-control lock (only the holder can). */
  release(sessionId: string, controllerId: string): Promise<BrowserControlResponse>;
  /** Tear down a session's browser (stream + CDP client + container). Call on terminate. */
  stopFor(sessionId: string): Promise<void>;
  /** Sweep orphaned browser containers (call on boot). */
  reap(): Promise<void>;
  /** Stop every stream + container (shutdown). */
  dispose(): Promise<void>;
  diagnosticSizes(): Record<string, number>;
}

export function createBrowserChannels(deps: BrowserChannelsDeps): BrowserChannels {
  const logger = deps.logger ?? {
    warn(msg, err) {
      // eslint-disable-next-line no-console
      console.warn(`[flock-orchestrator] ${msg}`, err);
    },
  };

  const layerA: BrowserLifecycle =
    deps.lifecycle ??
    (() => {
      const workerUrl = process.env.BROWSER_WORKER_URL;
      const workerTokenFile = process.env.BROWSER_WORKER_TOKEN_FILE;
      if (workerUrl || workerTokenFile) {
        if (!workerUrl || !workerTokenFile) {
          throw new Error('BROWSER_WORKER_URL and BROWSER_WORKER_TOKEN_FILE must be set together');
        }
        return new BrowserWorkerClient(workerUrl, workerTokenFile);
      }
      const docker = new Docker(
        deps.dockerSocket ? { socketPath: deps.dockerSocket } : undefined,
      ) as unknown as DockerLike;
      return new LayerABrowserManager({
        docker,
        resolveCdp: createDockerCdpResolver(docker),
        config: {
          // The Flock session-chrome image bridges CDP to a published port (plain
          // Chrome images bind the debugger to loopback only). See docker/Dockerfile.session-chrome.
          image: deps.image ?? process.env.BROWSER_IMAGE ?? 'flock/session-chrome:latest',
          maxConcurrent: deps.maxConcurrent ?? Number(process.env.BROWSER_MAX_CONCURRENT ?? 4),
          // T15(c): per-container resource caps (0 = leave unset). Defaults applied by
          // DEFAULT_LAYER_A_CONFIG; override per-deploy via env.
          ...(process.env.BROWSER_MEMORY_BYTES
            ? { memoryBytes: Number(process.env.BROWSER_MEMORY_BYTES) }
            : {}),
          ...(process.env.BROWSER_NANO_CPUS
            ? { nanoCpus: Number(process.env.BROWSER_NANO_CPUS) }
            : {}),
          ...(process.env.BROWSER_PIDS_LIMIT
            ? { pidsLimit: Number(process.env.BROWSER_PIDS_LIMIT) }
            : {}),
        },
      });
    })();

  // One CDP page client per session, shared by the stream (+ future input).
  const clients = new Map<string, Promise<CdpPageClient>>();
  function clientFor(sessionId: string): Promise<CdpPageClient> {
    let p = clients.get(sessionId);
    if (!p) {
      p = (async () => {
        const browser = layerA.get(sessionId) ?? (await layerA.launch(sessionId));
        return connectCdpPageClient(browser.cdpEndpoint);
      })().catch((err) => {
        clients.delete(sessionId); // allow a retry on next open
        throw err;
      });
      clients.set(sessionId, p);
    }
    return p;
  }

  // Route encoded frames to the live WS for the session (if the tab is open).
  const sinks = new Map<string, (payload: string) => void>();
  const screencast = new ScreencastManager({
    resolveClient: (sessionId) => clientFor(sessionId),
    sink: {
      send(sessionId, payload) {
        sinks.get(sessionId)?.(payload);
      },
    },
    // High JPEG quality (less compression grain) + a 4K cap so a supersampled
    // capture isn't downscaled. NOTE: CDP screencast captures at CSS resolution
    // and ignores deviceScaleFactor (verified), so sharpness comes from quality +
    // (optional) supersampling the viewport, not from a retina device factor.
    config: { maxWidth: 3840, maxHeight: 2160, quality: 92 },
  });

  // Last viewport requested per session, so the Chrome page renders AT the pane
  // size (fills + responsive, like Codex) instead of a fixed 800×600 letterbox.
  //
  // SUPERSAMPLE for crispness: CDP screencast captures at CSS resolution and
  // ignores deviceScaleFactor (verified), so to get a sharp image on a retina
  // display we render the page at pane-size × the client DPR (capped 2×) and let
  // the client downscale it into the pane. The page lays out at the larger
  // logical width (content appears a bit smaller) — the chosen sharpness/layout
  // trade-off. deviceScaleFactor stays 1 (it would only waste render work). The
  // frame metadata reports this CSS size, so input-coord mapping stays correct.
  const viewports = new Map<string, { width: number; height: number }>();
  async function applyViewport(
    sessionId: string,
    width: number,
    height: number,
    dpr: number,
  ): Promise<void> {
    const factor = Math.min(Math.max(dpr || 1, 1), 2);
    const vw = Math.round(width * factor);
    const vh = Math.round(height * factor);
    const prev = viewports.get(sessionId);
    if (prev && prev.width === vw && prev.height === vh) return;
    viewports.set(sessionId, { width: vw, height: vh });
    try {
      const client = await clientFor(sessionId);
      await client.setViewport(vw, vh, 1);
    } catch (err) {
      logger.warn(`browser viewport resize failed for ${sessionId}`, err);
    }
  }

  // Bandwidth controls (US-29, NFR-PERF3): concurrency cap, live quality, and a
  // pause/throttle when the pane is unfocused. Drives the screencast manager.
  const bandwidth = new BandwidthController({
    engine: new ScreencastEngineAdapter(screencast),
    controls: { maxConcurrentStreams: Number(process.env.SCREENCAST_MAX_CONCURRENT ?? 5) },
  });

  // Single-controller input takeover (US-28): shares the per-session CDP client.
  const input = new InputTakeoverController({
    resolveInputClient: (sessionId) => clientFor(sessionId),
    audit: deps.audit,
  });

  async function closeClient(sessionId: string): Promise<void> {
    const p = clients.get(sessionId);
    clients.delete(sessionId);
    if (!p) return;
    try {
      const c = await p;
      await c.close();
    } catch {
      /* already gone */
    }
  }

  async function stopFor(sessionId: string): Promise<void> {
    sinks.delete(sessionId);
    viewports.delete(sessionId);
    const holder = input.controllerOf(sessionId);
    if (holder) {
      await input
        .release(sessionId, holder)
        .catch((error) => logger.warn(`browser input release failed for ${sessionId}`, error));
    }
    try {
      await bandwidth.close(sessionId);
    } catch (err) {
      logger.warn(`screencast stop failed for ${sessionId}`, err);
    }
    await closeClient(sessionId);
    try {
      await layerA.stop(sessionId);
    } catch (err) {
      logger.warn(`browser container stop failed for ${sessionId}`, err);
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  const stopHeartbeat = attachWsHeartbeat(wss);

  function bindSocket(sessionId: string, controllerId: string, ws: WebSocket): void {
    sinks.set(sessionId, (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    });

    // Address-bar URL: push the current URL + every navigation to this client.
    let urlUnsub: (() => void) | null = null;
    const sendUrl = (url: string): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ channel: 'screencast', type: 'url', sessionId, url }));
      }
    };

    ws.on('message', (data) => {
      let msg: {
        op?: string;
        quality?: number;
        intent?: unknown;
        width?: number;
        height?: number;
        dpr?: number;
        url?: string;
      };
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return; // ignore malformed control frames
      }
      if (msg.op === 'input') {
        // Forward a user input intent (only the lock holder succeeds, US-28).
        const parsed = InputIntent.safeParse(msg.intent);
        if (!parsed.success) return;
        void input
          .forward(sessionId, controllerId, parsed.data)
          .catch((error) => logger.warn(`browser input forwarding failed for ${sessionId}`, error));
        return;
      }
      if (msg.op === 'resize' && typeof msg.width === 'number' && typeof msg.height === 'number') {
        // Render Chrome AT the pane size + DPR so the screencast fills + is crisp.
        void applyViewport(sessionId, msg.width, msg.height, msg.dpr ?? 1);
        return;
      }
      if (msg.op === 'navigate' && typeof msg.url === 'string') {
        void clientFor(sessionId)
          .then((c) => c.navigate(msg.url as string))
          .catch((err) => logger.warn(`browser navigate failed for ${sessionId}`, err));
        return;
      }
      if (msg.op === 'reload') {
        void clientFor(sessionId)
          .then((c) => c.reload())
          .catch((error) => logger.warn(`browser reload failed for ${sessionId}`, error));
        return;
      }
      if (msg.op === 'screencast:focus') {
        void bandwidth
          .focus(sessionId)
          .catch((error) => logger.warn(`browser focus failed for ${sessionId}`, error));
        return;
      }
      if (msg.op === 'screencast:blur') {
        void bandwidth
          .blur(sessionId)
          .catch((error) => logger.warn(`browser blur failed for ${sessionId}`, error));
        return;
      }
      if (msg.op === 'open') {
        // Lazy-launch the container (via clientFor) + start streaming (through the
        // bandwidth controller — concurrency cap), then wire the address bar.
        void bandwidth
          .open(sessionId)
          .then(async () => {
            const c = await clientFor(sessionId);
            const url = await c.currentUrl().catch(() => '');
            if (url) sendUrl(url);
            urlUnsub?.();
            urlUnsub = c.onUrl(sendUrl);
          })
          .catch((err) => {
            logger.warn(`screencast start failed for ${sessionId}`, err);
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  channel: 'screencast',
                  type: 'error',
                  sessionId,
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          });
      } else if (msg.op === 'close') {
        void bandwidth
          .close(sessionId)
          .catch((error) => logger.warn(`browser stream close failed for ${sessionId}`, error));
      } else if (msg.op === 'screencast:quality' && typeof msg.quality === 'number') {
        bandwidth.setQuality(sessionId, msg.quality);
      }
    });

    ws.on('close', () => {
      // Only drop this socket's sink; keep the container alive (the agent may be
      // driving it) until the session is terminated.
      if (sinks.get(sessionId)) sinks.delete(sessionId);
      urlUnsub?.();
      urlUnsub = null;
      void bandwidth
        .close(sessionId)
        .catch((error) => logger.warn(`browser socket close failed for ${sessionId}`, error));
    });
  }

  return {
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const match = /^\/ws\/screencast\/([^/]+)$/.exec(path);
        if (!match) return; // not ours — another handler owns it
        const sessionId = decodeURIComponent(match[1] ?? '');
        void (async () => {
          // T4/T5: Origin + per-session ownership. Reject before
          // touching the browser so a hostile page / non-owner can't take over.
          if (deps.authorizeUpgrade && !(await deps.authorizeUpgrade(req, sessionId))) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          const userId = await deps.resolveUserId(req.headers.cookie);
          if (!userId) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => bindSocket(sessionId, userId, ws));
        })().catch((error) => {
          logger.warn(`browser WebSocket upgrade failed for ${sessionId}`, error);
          socket.destroy();
        });
      });
    },
    async takeover(sessionId, controllerId, ip) {
      await input.takeover(sessionId, { controllerId, ip });
      return {
        sessionId,
        action: 'takeover',
        browserCdpEndpoint: layerA.get(sessionId)?.cdpEndpoint ?? null,
        inControl: true,
      };
    },
    async release(sessionId, controllerId) {
      await input.release(sessionId, controllerId);
      return {
        sessionId,
        action: 'release',
        browserCdpEndpoint: layerA.get(sessionId)?.cdpEndpoint ?? null,
        inControl: false,
      };
    },
    stopFor,
    diagnosticSizes: () => ({
      browserClients: clients.size,
      browserSinks: sinks.size,
      browserViewports: viewports.size,
    }),
    async reap() {
      try {
        await layerA.reap();
      } catch (err) {
        logger.warn('browser container reap failed', err);
      }
    },
    async dispose() {
      stopHeartbeat();
      await input.releaseAll().catch((error) => logger.warn('browser release-all failed', error));
      await bandwidth
        .stopAll()
        .catch((error) => logger.warn('browser stream stop-all failed', error));
      await Promise.all([...clients.keys()].map((id) => closeClient(id)));
      await layerA.stopAll().catch((error) => logger.warn('browser worker stop-all failed', error));
    },
  };
}
