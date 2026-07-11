/**
 * BrowserPane — Layer C screencast view of a session's isolated Chrome (US-27)
 * PLUS input takeover (US-28). The Browser tab in the center tab group mounts it:
 *   - opens the `screencast:<id>` channel ON DEMAND while mounted (tab open) and
 *     stops it on unmount (tab switch) via {@link useScreencast}
 *   - renders each inbound JPEG frame on an `<img>` (data: URL) — we do NOT iframe
 *     the target site (framing is blocked; spec §4.3 / PRD §6.5)
 *   - a Take/Release control: while in control, DOM pointer/keyboard events on the
 *     frame are translated to CDP-shaped input intents (pure helpers in
 *     `browserInput`) and forwarded over the SAME socket; the orchestrator's
 *     InputTakeoverController dispatches them as CDP `Input.*` events.
 *
 * The Chrome is the USER's browser pane (agents use their own browser tooling);
 * it runs as a container on the orchestrator host. The WS factory is injectable
 * so the component is unit-testable without a real socket.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import {
  BrowserControlResponse as BrowserControlResponseSchema,
  type BrowserControlResponse,
  type InputIntent,
} from '@flock/shared';
import { apiRequest } from '../../lib/apiClient';
import { useScreencast, type ScreencastConnectionState, type WsFactory } from './useScreencast';
import { frameToDataUrl, type ScreencastFrameMessage } from './screencastProtocol';
import { useBrowserControl, type BrowserControlTransport } from './useBrowserControl';
import {
  cdpModifiers,
  keyIntent,
  mapPointToViewport,
  mouseIntent,
  scrollIntent,
  type ViewportMapping,
} from './browserInput';

export type { WsLike, WsFactory } from './useScreencast';

export interface BrowserPaneProps {
  /** The single authoritative session id (spec §4.2). */
  sessionId: string;
  /** Injected for tests; forwarded to useScreencast. */
  wsFactory?: WsFactory;
}

function statusLabel(state: ScreencastConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'connecting…';
    case 'closed':
      return 'reconnecting…';
    default:
      return '';
  }
}

async function postControl(path: string): Promise<BrowserControlResponse> {
  return apiRequest(path, { method: 'POST', schema: BrowserControlResponseSchema });
}

export default function BrowserPane({ sessionId, wsFactory }: BrowserPaneProps): JSX.Element {
  const [frame, setFrame] = useState<ScreencastFrameMessage | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  // Sharper (supersampled) capture trades apparent size for crispness on retina.
  // Default OFF (WYSIWYG size); the toolbar toggles it.
  const [sharp, setSharp] = useState(false);
  const editingUrl = useRef(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { state, send } = useScreencast(sessionId, {
    onFrame: (f) => setFrame(f),
    onControl: (m) => {
      // Keep the address bar in sync with the page's URL (unless the user is
      // mid-edit, so we don't clobber what they're typing).
      if (m.type === 'url' && typeof m.url === 'string' && !editingUrl.current) {
        setUrlDraft(m.url);
      }
    },
    wsFactory,
  });

  const navigate = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      // Add a scheme if the user typed a bare host/path.
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      send(JSON.stringify({ op: 'navigate', sessionId, url }));
      editingUrl.current = false;
      imgRef.current?.focus();
    },
    [sessionId, send],
  );
  const reload = useCallback(
    () => send(JSON.stringify({ op: 'reload', sessionId })),
    [sessionId, send],
  );

  // Pause/throttle the stream when the whole tab is backgrounded (US-29 bandwidth
  // control) — focus on visible, blur on hidden.
  useEffect(() => {
    if (state !== 'open') return;
    const onVis = (): void =>
      send(
        JSON.stringify({
          op: document.visibilityState === 'visible' ? 'screencast:focus' : 'screencast:blur',
          sessionId,
        }),
      );
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [state, sessionId, send]);

  // Drive the remote viewport to the pane size so the page renders AT our size
  // (fills + responsive, like Codex) instead of a fixed 800×600 letterbox. Send
  // on connect + on every pane resize (debounced).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || state !== 'open') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const push = (): void => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      // Sharp mode supersamples (capture at pane × DPR, downscaled → crisp on
      // retina); otherwise capture at pane size (WYSIWYG, true content size).
      const dpr = sharp ? window.devicePixelRatio || 1 : 1;
      if (w > 0 && h > 0)
        send(JSON.stringify({ op: 'resize', sessionId, width: w, height: h, dpr }));
    };
    const debounced = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, 150);
    };
    push(); // initial size on (re)connect
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(debounced) : null;
    ro?.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      ro?.disconnect();
    };
  }, [state, sessionId, send, sharp]);

  // Transport: REST takeover/release + input forwarding over the screencast socket.
  const transport = useMemo<BrowserControlTransport>(
    () => ({
      takeover: (id) => postControl(`/api/sessions/${id}/browser/takeover`),
      release: (id) => postControl(`/api/sessions/${id}/browser/release`),
      sendInput: (id, intent: InputIntent) =>
        send(JSON.stringify({ op: 'input', sessionId: id, intent })),
    }),
    [send],
  );

  const { inControl, pending, error, takeover, release, sendInput } = useBrowserControl(
    sessionId,
    transport,
  );

  const mapping = useCallback((): ViewportMapping | null => {
    const img = imgRef.current;
    if (!img || !frame) return null;
    return {
      renderedWidth: img.clientWidth,
      renderedHeight: img.clientHeight,
      deviceWidth: frame.metadata.deviceWidth,
      deviceHeight: frame.metadata.deviceHeight,
    };
  }, [frame]);

  const pointInElement = useCallback((e: React.MouseEvent | React.WheelEvent) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!inControl) return;
      const m = mapping();
      if (!m) return;
      imgRef.current?.focus();
      sendInput(
        mouseIntent({
          type: 'mousePressed',
          point: mapPointToViewport(pointInElement(e), m),
          button: e.button,
          clickCount: e.detail || 1,
          modifiers: cdpModifiers(e),
        }),
      );
    },
    [inControl, mapping, pointInElement, sendInput],
  );

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (!inControl) return;
      const m = mapping();
      if (!m) return;
      sendInput(
        mouseIntent({
          type: 'mouseReleased',
          point: mapPointToViewport(pointInElement(e), m),
          button: e.button,
          clickCount: e.detail || 1,
          modifiers: cdpModifiers(e),
        }),
      );
    },
    [inControl, mapping, pointInElement, sendInput],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!inControl) return;
      const m = mapping();
      if (!m) return;
      sendInput(
        scrollIntent({
          point: mapPointToViewport(pointInElement(e), m),
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: cdpModifiers(e),
        }),
      );
    },
    [inControl, mapping, pointInElement, sendInput],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!inControl) return;
      e.preventDefault();
      sendInput(
        keyIntent({
          type: 'keyDown',
          key: e.key,
          code: e.code,
          text: e.key.length === 1 ? e.key : undefined,
          modifiers: cdpModifiers(e),
        }),
      );
    },
    [inControl, sendInput],
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (!inControl) return;
      e.preventDefault();
      sendInput(keyIntent({ type: 'keyUp', key: e.key, code: e.code, modifiers: cdpModifiers(e) }));
    },
    [inControl, sendInput],
  );

  const showHint = state !== 'open' || frame === null;

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-flock-bg"
      data-session-id={sessionId}
    >
      <div className="flex items-center gap-2 border-b border-flock-border-subtle px-2 py-1.5 text-xs">
        <button
          type="button"
          onClick={reload}
          aria-label="Reload"
          title="Reload"
          className="rounded px-1.5 py-1 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary"
        >
          <RotateCw className="size-3.5" />
        </button>
        <input
          data-testid="browser-url"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onFocus={(e) => {
            editingUrl.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            editingUrl.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(urlDraft);
          }}
          spellCheck={false}
          placeholder="Enter a URL or localhost dev server…"
          className="min-w-0 flex-1 rounded-md border border-flock-border-subtle bg-flock-surface-2 px-2 py-1 font-mono text-2xs text-flock-ink-primary outline-none focus:border-flock-accent/60"
        />
        {inControl ? (
          <button
            type="button"
            onClick={() => void release()}
            disabled={pending}
            data-testid="browser-release"
            className="shrink-0 rounded bg-flock-accent/15 px-2 py-0.5 font-medium text-flock-accent hover:bg-flock-accent/25 disabled:opacity-50"
          >
            Release control
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void takeover()}
            disabled={pending || frame === null}
            data-testid="browser-takeover"
            className="shrink-0 rounded bg-flock-surface-2 px-2 py-0.5 font-medium text-flock-ink-primary hover:bg-flock-surface-3 disabled:opacity-50"
          >
            Take control
          </button>
        )}
        <button
          type="button"
          onClick={() => setSharp((v) => !v)}
          aria-pressed={sharp}
          data-testid="browser-sharp"
          title={
            sharp
              ? 'Sharp (HiDPI) — crisper, content appears smaller. Click for actual size.'
              : 'Actual size — true content size. Click for sharper (HiDPI) on retina.'
          }
          className={`shrink-0 rounded px-2 py-0.5 font-medium ${
            sharp
              ? 'bg-flock-accent/15 text-flock-accent'
              : 'bg-flock-surface-2 text-flock-ink-muted hover:text-flock-ink-primary'
          }`}
        >
          {sharp ? 'Sharp' : 'Actual size'}
        </button>
        <span className="shrink-0 text-flock-ink-muted" data-testid="browser-control-state">
          {inControl ? 'You are in control' : 'View only'}
        </span>
        {error ? (
          <span className="text-status-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        {frame ? (
          <img
            ref={imgRef}
            data-testid="screencast-frame"
            alt="session browser"
            className={`h-full w-full object-contain outline-none ${
              inControl ? 'ring-1 ring-inset ring-flock-accent/60' : ''
            }`}
            src={frameToDataUrl(frame)}
            tabIndex={inControl ? 0 : -1}
            draggable={false}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
          />
        ) : null}
        {showHint ? (
          <div
            data-testid="screencast-status"
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/60 px-3 py-1 text-xs text-white"
          >
            {state === 'open' ? 'waiting for frames…' : statusLabel(state)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
