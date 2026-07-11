import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FitAddon, Terminal as GhosttyTerminal } from 'ghostty-web';
import {
  loadTerminalFont,
  TERMINAL_FONT_FAMILY,
  TERMINAL_SYMBOL_FONT_FAMILY,
} from '../../styles/terminal-fonts';
import { usePtyWebSocket } from './usePtyWebSocket';

const TERMINAL_BG = '#090909';
const SCROLLBACK_LINES = 10_000;

type GhosttyModule = typeof import('ghostty-web');
let ghosttyReady: Promise<GhosttyModule> | null = null;

function ensureGhostty(): Promise<GhosttyModule> {
  ghosttyReady ??= import('ghostty-web').then(async (module) => {
    await Promise.all([module.init(), loadTerminalFont()]);
    return module;
  });
  return ghosttyReady;
}

interface Runtime {
  readonly terminal: GhosttyTerminal;
  readonly fit: FitAddon;
}

export interface GhosttyMobileTerminalProps {
  readonly sessionId: string;
  readonly registerInput?: (send: ((text: string) => void) | null) => void;
  readonly registerFocus?: (focus: (() => void) | null) => void;
}

/** Canvas-backed mobile terminal. Desktop intentionally remains on xterm. */
export default function GhosttyMobileTerminal({
  sessionId,
  registerInput,
  registerFocus,
}: GhosttyMobileTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let created: Runtime | null = null;

    void ensureGhostty()
      .then(({ FitAddon: GhosttyFitAddon, Terminal }) => {
        if (disposed) return;
        const terminal = new Terminal({
          cursorBlink: true,
          cursorStyle: 'block',
          fontFamily: `'${TERMINAL_FONT_FAMILY}', '${TERMINAL_SYMBOL_FONT_FAMILY}', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
          fontSize: 14,
          scrollback: SCROLLBACK_LINES,
          smoothScrollDuration: 0,
          theme: {
            background: TERMINAL_BG,
            foreground: '#c8ccd4',
            cursor: '#e6e6e6',
            cursorAccent: TERMINAL_BG,
            selectionBackground: '#3a4860',
            selectionForeground: '#ffffff',
          },
        });
        const fit = new GhosttyFitAddon();
        terminal.loadAddon(fit);
        terminal.open(host);
        disableMobileCanvasScrollbar(terminal);
        installMobileTextSymbolRendering(terminal);
        terminal.textarea?.classList.add('flock-ghostty-mobile-input');
        terminal.textarea?.setAttribute('enterkeyhint', 'enter');
        if (terminal.textarea) terminal.textarea.disabled = true;
        fit.fit();
        created = { terminal, fit };
        setRuntime(created);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : 'Unable to load terminal renderer');
        }
      });

    return () => {
      disposed = true;
      setRuntime(null);
      created?.fit.dispose();
      created?.terminal.dispose();
      host.replaceChildren();
    };
  }, [sessionId]);

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-testid="ghostty-mobile-terminal"
      style={{ backgroundColor: TERMINAL_BG }}
    >
      <div ref={hostRef} className="h-full w-full touch-none" />
      {runtime ? (
        <GhosttyConnection
          key={sessionId}
          sessionId={sessionId}
          runtime={runtime}
          registerInput={registerInput}
          registerFocus={registerFocus}
        />
      ) : null}
      {loadError ? <TerminalNotice tone="error">{loadError}</TerminalNotice> : null}
    </div>
  );
}

function GhosttyConnection({
  sessionId,
  runtime,
  registerInput,
  registerFocus,
}: {
  sessionId: string;
  runtime: Runtime;
  registerInput?: (send: ((text: string) => void) | null) => void;
  registerFocus?: (focus: (() => void) | null) => void;
}): JSX.Element | null {
  const { terminal, fit } = runtime;
  const getInitialSize = useCallback(
    () => ({ cols: terminal.cols, rows: terminal.rows }),
    [terminal],
  );
  const { state, sendInput, sendResize, reconnectNow } = usePtyWebSocket(sessionId, {
    getInitialSize,
    onData: (bytes) => terminal.write(bytes),
    onReconnect: () => {
      terminal.reset();
      fit.fit();
      terminal.scrollToBottom();
    },
  });

  useEffect(() => {
    const input = terminal.onData(sendInput);
    return () => input.dispose();
  }, [sendInput, terminal]);

  useEffect(() => {
    const resize = terminal.onResize(({ cols, rows }) => sendResize(cols, rows));
    return () => resize.dispose();
  }, [sendResize, terminal]);

  useEffect(() => {
    if (!registerInput) return;
    registerInput((text) => terminal.input(text, true));
    return () => registerInput(null);
  }, [registerInput, terminal]);

  useEffect(() => {
    if (!registerFocus) return;
    registerFocus(() => focusGhosttyInput(terminal));
    return () => registerFocus(null);
  }, [registerFocus, terminal]);

  useEffect(() => {
    if (state !== 'open') return;
    fitMobileTerminal(terminal, fit);
    sendResize(terminal.cols, terminal.rows);
    terminal.scrollToBottom();
  }, [fit, sendResize, state, terminal]);

  useEffect(() => {
    const parent = terminal.element?.parentElement;
    if (!parent) return;
    let timer = 0;
    let frame = 0;
    const refit = (): void => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        fitMobileTerminal(terminal, fit);
        // Ghostty's FitAddon holds a short resize lock. A second pass after the
        // lock clears handles Safari's two-phase visual viewport updates.
        timer = window.setTimeout(() => fitMobileTerminal(terminal, fit), 80);
      });
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => refit());
    observer?.observe(parent);
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
    window.visualViewport?.addEventListener('resize', refit);
    window.visualViewport?.addEventListener('scroll', refit);
    refit();
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', refit);
      window.removeEventListener('orientationchange', refit);
      window.visualViewport?.removeEventListener('resize', refit);
      window.visualViewport?.removeEventListener('scroll', refit);
    };
  }, [fit, terminal]);

  useEffect(() => installMobileTouch(runtime.terminal, runtime.fit), [runtime]);

  if (state === 'open') return null;
  if (state === 'exited') return <TerminalNotice>Session ended</TerminalNotice>;
  if (state === 'closed') {
    return (
      <TerminalNotice>
        Reconnecting…
        <button type="button" className="ml-2 underline" onClick={reconnectNow}>
          Retry
        </button>
      </TerminalNotice>
    );
  }
  return <TerminalNotice>Connecting…</TerminalNotice>;
}

interface MobileTouchTerminal {
  readonly element?: HTMLElement;
  readonly textarea?: HTMLTextAreaElement;
  readonly renderer?: { getMetrics(): { height: number } };
  scrollLines(lines: number): void;
  scrollToBottom(): void;
}

export function installMobileTouch(
  terminal: MobileTouchTerminal,
  fit: { fit(): void },
): () => void {
  const element = terminal.element;
  if (!element) return () => undefined;
  let lastY = 0;
  let pendingLines = 0;
  let hadTouchMove = false;
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch) return;
    lastY = touch.clientY;
    pendingLines = 0;
    hadTouchMove = false;
    if (terminal.textarea) terminal.textarea.disabled = true;
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch) return;
    hadTouchMove = true;
    const cellHeight = terminal.renderer?.getMetrics().height ?? 17;
    pendingLines += (lastY - touch.clientY) / cellHeight;
    lastY = touch.clientY;
    const lines = pendingLines < 0 ? Math.ceil(pendingLines) : Math.floor(pendingLines);
    if (lines !== 0) {
      terminal.scrollLines(lines);
      pendingLines -= lines;
      event.preventDefault();
    }
  };
  const onTouchEnd = (): void => {
    if (!hadTouchMove) focusGhosttyInput(terminal);
  };
  const onBlur = (): void => {
    terminal.textarea?.classList.remove('flock-ghostty-mobile-input-active');
    if (terminal.textarea) terminal.textarea.disabled = true;
    window.setTimeout(() => {
      fit.fit();
      terminal.scrollToBottom();
    }, 200);
  };

  element.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  element.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  element.addEventListener('touchend', onTouchEnd, { capture: true });
  terminal.textarea?.addEventListener('blur', onBlur);
  return () => {
    element.removeEventListener('touchstart', onTouchStart, { capture: true });
    element.removeEventListener('touchmove', onTouchMove, { capture: true });
    element.removeEventListener('touchend', onTouchEnd, { capture: true });
    terminal.textarea?.removeEventListener('blur', onBlur);
  };
}

function focusGhosttyInput(terminal: MobileTouchTerminal): void {
  const textarea = terminal.textarea;
  if (textarea) textarea.disabled = false;
  textarea?.classList.add('flock-ghostty-mobile-input-active');
  textarea?.focus({ preventScroll: true });
  window.setTimeout(() => textarea?.focus({ preventScroll: true }), 0);
}

interface FittableTerminal {
  readonly element?: HTMLElement;
}

interface TerminalWithCanvasRenderer {
  readonly renderer?: object;
}

/**
 * ghostty-web 0.4.0 draws its scrollbar inside the terminal canvas and clears
 * the rightmost 14px first, covering roughly two columns on a phone. Mobile
 * already has direct touch scrollback, so suppress only that visual overlay.
 * Keep this isolated for removal when ghostty-web exposes a supported option.
 */
export function disableMobileCanvasScrollbar(terminal: TerminalWithCanvasRenderer): void {
  const renderer = terminal.renderer as
    | { renderScrollbar?: (...args: readonly unknown[]) => void }
    | undefined;
  if (typeof renderer?.renderScrollbar === 'function') {
    renderer.renderScrollbar = () => undefined;
  }
}

type CanvasFillText = (text: string, x: number, y: number, maxWidth?: number) => void;

/** Media-control glyphs are emoji-default on iOS; terminals need text glyphs. */
export function forceTerminalTextPresentation(text: string): string {
  return text.replace(/([\u23e9-\u23fa])(?:\ufe0e|\ufe0f)?/gu, '$1\ufe0e');
}

/**
 * Keep emoji presentation out of Ghostty's canvas without rewriting PTY output
 * or its terminal buffer. The renderer remains responsible for cell widths.
 */
export function installMobileTextSymbolRendering(terminal: TerminalWithCanvasRenderer): void {
  const renderer = terminal.renderer as
    | { ctx?: { fillText: CanvasFillText }; flockTextSymbolsInstalled?: boolean }
    | undefined;
  if (!renderer?.ctx || renderer.flockTextSymbolsInstalled) return;
  const originalFillText = renderer.ctx.fillText.bind(renderer.ctx);
  renderer.ctx.fillText = (text, x, y, maxWidth) => {
    const normalized = forceTerminalTextPresentation(text);
    if (maxWidth === undefined) originalFillText(normalized, x, y);
    else originalFillText(normalized, x, y, maxWidth);
  };
  renderer.flockTextSymbolsInstalled = true;
}

/** Constrain Ghostty to the visible viewport before deriving rows and columns. */
export function fitMobileTerminal(
  terminal: FittableTerminal,
  fit: { fit(): void },
): void {
  const element = terminal.element;
  if (!element) return;
  const parent = element.parentElement;
  const visualWidth = window.visualViewport?.width ?? window.innerWidth;
  const left = Math.max(0, element.getBoundingClientRect().left);
  const visibleWidth = Math.max(1, Math.floor(visualWidth - left));
  const parentWidth = parent?.clientWidth || visibleWidth;
  element.style.width = `${Math.min(parentWidth, visibleWidth)}px`;
  element.style.maxWidth = '100%';
  element.style.minWidth = '0';
  fit.fit();
}

function TerminalNotice({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'error';
}): JSX.Element {
  return (
    <div
      className={`absolute inset-x-2 bottom-2 rounded bg-black/75 px-2 py-1 text-center text-2xs ${tone === 'error' ? 'text-status-error' : 'text-white/70'}`}
    >
      {children}
    </div>
  );
}
