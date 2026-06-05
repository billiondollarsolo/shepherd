/**
 * CDP page client — connects `chrome-remote-interface` to a session's running
 * Chrome (the loopback host port Layer A published) and adapts it to the small
 * {@link CdpScreencastClient} + {@link CdpInputClient} seams Layer C expects.
 *
 * Layer A resolves a BROWSER-level CDP endpoint; screencast + input act on a
 * PAGE target, so we discover (or create) a page target via the HTTP `/json`
 * list and connect to it. One shared client serves both the screencast stream
 * and input takeover for a session (Layer C resolves each independently, so the
 * caller caches one client per session).
 */
import CDP from 'chrome-remote-interface';

import type { CdpScreencastClient } from './layerC/types.js';
import type { CdpInputClient } from './layerC/input-types.js';

/** One Chrome page client serving both screencast frames and input dispatch. */
export type CdpPageClient = CdpScreencastClient &
  CdpInputClient & {
    /** Resize the page viewport so the screencast fills the pane (responsive). */
    setViewport(width: number, height: number, deviceScaleFactor?: number): Promise<void>;
    /** Navigate the page to a URL (address-bar entry). */
    navigate(url: string): Promise<void>;
    /** Reload the current page. */
    reload(): Promise<void>;
    /** The page's current URL (for the address bar on attach). */
    currentUrl(): Promise<string>;
    /** Subscribe to URL changes (navigation / SPA route change). Returns unsubscribe. */
    onUrl(listener: (url: string) => void): () => void;
    close(): Promise<void>;
  };

/**
 * Connect to a page target inside the session's Chrome and return the adapted
 * client. `cdpEndpointUrl` is Layer A's `ws://127.0.0.1:<hostPort>/devtools/...`.
 */
export async function connectCdpPageClient(cdpEndpointUrl: string): Promise<CdpPageClient> {
  const u = new URL(cdpEndpointUrl);
  const host = u.hostname;
  const port = Number(u.port);

  // Find an existing page target, or open a fresh blank one.
  const targets = await CDP.List({ host, port });
  const page = targets.find((t) => t.type === 'page') ?? (await CDP.New({ host, port }));
  const client = await CDP({ host, port, target: page.webSocketDebuggerUrl ?? page.id });
  await client.Page.enable();

  return {
    Page: {
      startScreencast: (params) => client.Page.startScreencast(params),
      stopScreencast: () => client.Page.stopScreencast(),
      screencastFrameAck: (params) => client.Page.screencastFrameAck(params),
      // CRI is an EventEmitter; on()/off() give a clean unsubscribe handle.
      screencastFrame: (listener) => {
        const handler = (frame: Parameters<typeof listener>[0]): void => listener(frame);
        client.on('Page.screencastFrame', handler);
        return () => client.off('Page.screencastFrame', handler);
      },
    },
    Input: {
      dispatchMouseEvent: (params) => client.Input.dispatchMouseEvent(params),
      dispatchKeyEvent: (params) => client.Input.dispatchKeyEvent(params),
    },
    setViewport: async (width, height, deviceScaleFactor = 1) => {
      await client.Emulation.setDeviceMetricsOverride({
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        deviceScaleFactor,
        mobile: false,
      });
    },
    navigate: async (url) => {
      await client.Page.navigate({ url });
    },
    reload: async () => {
      await client.Page.reload();
    },
    currentUrl: async () => {
      const h = await client.Page.getNavigationHistory();
      return h.entries[h.currentIndex]?.url ?? '';
    },
    onUrl: (listener) => {
      // Main-frame navigations + same-document (SPA) route changes.
      const onNav = (e: { frame?: { url?: string; parentId?: string } }): void => {
        if (e?.frame && !e.frame.parentId && e.frame.url) listener(e.frame.url);
      };
      const onWithin = (e: { url?: string }): void => {
        if (e?.url) listener(e.url);
      };
      client.on('Page.frameNavigated', onNav as (p: never) => void);
      client.on('Page.navigatedWithinDocument', onWithin as (p: never) => void);
      return () => {
        client.off('Page.frameNavigated', onNav as (p: never) => void);
        client.off('Page.navigatedWithinDocument', onWithin as (p: never) => void);
      };
    },
    close: () => client.close(),
  };
}
