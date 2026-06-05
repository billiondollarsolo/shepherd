/**
 * Terminal — mounts xterm.js bound to a session's `pty:<id>` stream (US-12),
 * tuned for a LOCAL-TERMINAL-GRADE experience:
 *   - xterm's DOM renderer (NOT the WebGL/GPU addon): in a busy multi-pane grid
 *     the GPU renderer was fragile — a pane could lose its GL frame (blank until a
 *     re-show) or get a corrupted glyph atlas on resize (garbled glyphs an
 *     alt-screen TUI never repaints over). The DOM renderer is rock-solid for this
 *     (box-drawing/unicode/colours all render identically); we trade a little
 *     fast-scroll snappiness for no blanking/garble.
 *   - Unicode 11 width handling (correct wide-char / emoji / CJK columns);
 *   - clickable web links (e.g. the agent's OAuth URL);
 *   - OSC 52 clipboard integration;
 *   - a full 16-colour professional palette + tuned cursor/selection/font.
 *
 * It pipes inbound PTY bytes to `term.write` (alt-screen apps like vim/htop and
 * box-drawing TUIs "just work" — xterm is a full VT/ANSI emulator incl. the DEC
 * Special Graphics charset), forwards keystrokes upstream, and fits the grid to
 * the pane (re-fitting on font load + socket open so tmux always gets the real
 * size). The xterm + WS factories are injectable so this is unit-testable.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal as XTerm, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { usePtyWebSocket, type WsFactory } from './usePtyWebSocket';
import { loadTerminalFont } from '../../styles/terminal-fonts';
import { stripTerminalReports } from './vt-reports';

/** Minimal xterm surface used here (lets tests inject a fake terminal). */
export interface XtermLike {
  open(el: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): void;
  loadAddon(addon: unknown): void;
  /** Move keyboard focus into the terminal (real xterm; test fake may omit). */
  focus?(): void;
  /** Clear the buffer + scrollback (used to repaint cleanly on RECONNECT so the
   *  resume replay replaces the stale screen instead of being appended). */
  reset?(): void;
  dispose(): void;
  readonly cols: number;
  readonly rows: number;
}

export type XtermFactory = (opts: ITerminalOptions) => XtermLike;

export interface TerminalProps {
  /** The single authoritative session id (spec §4.2). */
  sessionId: string;
  /** Injected for tests; defaults to the real xterm + addons. */
  xtermFactory?: XtermFactory;
  /** Injected for tests; forwarded to usePtyWebSocket. */
  wsFactory?: WsFactory;
  /**
   * Optional: receive a stable writer into this terminal's PTY (and `null` on
   * unmount). Lets a parent expose the terminal's input to the file tree /
   * drag-and-drop without coupling Terminal to a store.
   */
  registerInput?: (send: ((text: string) => void) | null) => void;
  /**
   * Optional command to run ONCE when the PTY first opens (used by split panes
   * created as "Command"/agent splits — e.g. `npm run dev` or `claude`). Typed
   * into the fresh shell with a trailing Enter.
   */
  initialCommand?: string;
}

/** The single terminal background, shared by xterm AND the wrapper so the
 *  unfilled letterbox margin blends in (no mismatched border). */
const TERMINAL_BG = '#0b0e14';

/**
 * A polished, widely-loved 16-colour palette (One Dark family) on the Flock dark
 * background. Tuned for legibility + matching the paddock's accent so the
 * terminal feels native to the app, not bolted on.
 */
const THEME: ITheme = {
  background: TERMINAL_BG,
  foreground: '#c8ccd4',
  cursor: '#e6e6e6',
  cursorAccent: TERMINAL_BG,
  selectionBackground: '#3a4860',
  selectionForeground: '#ffffff',
  black: '#3f4451',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#c8ccd4',
  brightBlack: '#5c6370',
  brightRed: '#ef7780',
  brightGreen: '#a6d189',
  brightYellow: '#f0ca8a',
  brightBlue: '#74bdf2',
  brightMagenta: '#d49ae6',
  brightCyan: '#6cc7d6',
  brightWhite: '#ffffff',
};

const DEFAULT_OPTS: ITerminalOptions = {
  convertEol: false,
  cursorBlink: true,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  // A LITERAL stack — never a CSS var(). xterm applies this both as an inline
  // style AND for canvas/WebGL glyph measurement; a `var(--x)` that is undefined
  // (or simply unsupported by the measurement path) invalidates the WHOLE
  // declaration, so the browser silently falls back to Times New Roman (a
  // proportional serif) and the grid renders loose + uneven.
  //
  // Primary is the self-hosted Nerd-patched JetBrains Mono (text + Powerline/
  // Devicon icons so TUI/shell glyphs render like a native terminal); plain
  // JetBrains Mono is the instant fallback while the ~1 MB Nerd font loads. See
  // styles/terminal-fonts.ts.
  fontFamily:
    "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 14,
  fontWeight: 400,
  // The Nerd build ships Regular (400) + Bold (700) only — request 700 so bold
  // text uses a real face instead of a synthesised/incorrect weight.
  fontWeightBold: 700,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 10_000,
  smoothScrollDuration: 0,
  drawBoldTextInBrightColors: true,
  // Required for the unicode11 + clipboard addons.
  allowProposedApi: true,
  // Let the agent (not the browser) own right-click etc.; allow native selection.
  rightClickSelectsWord: true,
  theme: THEME,
};

export default function Terminal({
  sessionId,
  xtermFactory,
  wsFactory,
  registerInput,
  initialCommand,
}: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cmdSentRef = useRef(false);
  const termRef = useRef<XtermLike | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Stable refs to bridge the xterm instance <-> the WS hook without reordering
  // hooks: the hook owns the socket; the effect below owns the terminal.
  const sendInputRef = useRef<(input: string) => void>(() => {});
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {});
  // A stable fit() the open-effect can call once the socket is ready.
  const doFitRef = useRef<() => void>(() => {});

  // Estimate the grid size from the container's pixels BEFORE the socket opens,
  // so the PTY is created at (about) the right size and a fresh shell prints its
  // prompt at the correct width — no startup resize-reflow ("prompt twice"). The
  // exact FitAddon size still follows via the debounced resize. Cell metrics
  // track DEFAULT_OPTS (fontSize 14, lineHeight 1.2): ~8.4px wide, 16.8px tall.
  const getInitialSize = useCallback((): { cols: number; rows: number } | null => {
    // Prefer xterm's EXACT fitted size (the layout effect below fits before the
    // WS connect effect runs), so the PTY opens at precisely the grid size and
    // needs NO startup resize → a fresh shell prints its prompt once (no reflow
    // and no prompt-redraws accumulating in the daemon scrollback). Fall back to
    // a pixel estimate if xterm isn't up yet.
    const t = termRef.current;
    if (t && t.cols > 0 && t.rows > 0) return { cols: t.cols, rows: t.rows };
    const el = containerRef.current;
    if (!el) return null;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return null;
    return { cols: Math.max(2, Math.floor(w / 8.4)), rows: Math.max(2, Math.floor(h / 16.8)) };
  }, []);

  const { state, sendInput, sendResize } = usePtyWebSocket(sessionId, {
    onData: (bytes) => termRef.current?.write(bytes),
    wsFactory,
    getInitialSize,
    // On RECONNECT the terminal kept its pre-drop screen; clear it so the server's
    // resume replay repaints cleanly instead of being appended (the duplicate
    // prompts / stacked agent welcome boxes). Re-fit after, then the replay paints.
    onReconnect: () => {
      termRef.current?.reset?.();
      doFitRef.current();
    },
  });
  sendInputRef.current = sendInput;
  sendResizeRef.current = sendResize;

  // useLayoutEffect (not useEffect) so xterm is created + first-fitted BEFORE the
  // passive WS-connect effect runs — that lets us open the PTY at the EXACT grid
  // size (getInitialSize reads the fitted terminal) and seed the resize dedupe so
  // no startup SIGWINCH is sent (the cause of bash reprinting its prompt).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const usingFake = xtermFactory !== undefined;
    const make: XtermFactory =
      xtermFactory ?? ((opts) => new XTerm(opts) as unknown as XtermLike);
    const term = make(DEFAULT_OPTS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    term.open(el);
    term.onData((data) => {
      // Drop xterm's auto DA/XTVERSION replies — over the WS+tmux bridge they
      // race the prompt and leak as garbage (e.g. `0;276;0c`). See vt-reports.ts.
      const clean = stripTerminalReports(data);
      if (clean) sendInputRef.current(clean);
    });

    // --- elite addons (real xterm only; the test fake skips these) -----------
    // NOTE: deliberately NO WebGL addon — xterm's DOM renderer is the primary
    // renderer here for multi-pane stability (no GL frame loss / atlas garble).
    if (!usingFake) {
      const real = term as unknown as XTerm;
      // Unicode 11 widths (emoji / CJK / wide glyphs render in the right columns).
      try {
        term.loadAddon(new Unicode11Addon());
        real.unicode.activeVersion = '11';
      } catch {
        /* proposed API unavailable; default unicode is fine */
      }
      // Clickable links (the agent's OAuth URL, file URLs, etc.). Open in a new tab.
      try {
        term.loadAddon(
          new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')),
        );
      } catch {
        /* links are a nicety */
      }
      // OSC 52 clipboard (agents that copy to the system clipboard).
      try {
        term.loadAddon(new ClipboardAddon());
      } catch {
        /* clipboard is a nicety */
      }
    }

    let disposed = false;
    // Resize is DEBOUNCED + DEDUPED. doFit runs many times in the first ~200ms
    // (mount, rAF, timeout, font-load, ResizeObserver settle, socket-open) and on
    // every splitter drag; sending a SIGWINCH for each one makes a freshly-spawned
    // TUI (Claude) redraw mid-startup and garble (and a shell reprint its prompt).
    // So fit() visually every time, but coalesce the actual resize into ONE send
    // of the latest size, and never resend an unchanged size.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = 0;
    let lastRows = 0;
    const scheduleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        const { cols, rows } = term;
        if (cols <= 0 || rows <= 0) return;
        if (cols === lastCols && rows === lastRows) return;
        lastCols = cols;
        lastRows = rows;
        sendResizeRef.current(cols, rows);
      }, 60);
    };
    // Coalesce ALL fit triggers (ResizeObserver, window resize, splitter drag,
    // right-panel toggle, focus⇄grid show/hide) into ONE fit after the size
    // SETTLES. Fitting on every tick reflows xterm's buffer repeatedly, which
    // visibly garbles alt-screen TUIs (gemini/claude/htop) mid-drag and can leave
    // WebGL artifacts. One settled fit → one SIGWINCH → the app repaints once.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const fitAndSync = (): void => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // container not laid out yet; ignore
      }
      scheduleResize();
      // NOTE: no explicit refresh() here — FitAddon.fit() calls term.resize() on
      // any dimension change, which makes the DOM renderer repaint from the buffer.
      // (The old forced full-viewport refresh was only needed for the WebGL
      // renderer's frame-loss/atlas-corruption on resize; WebGL is gone.)
    };
    const doFit = (): void => {
      // Never fit a terminal that's been disposed (StrictMode/unmount races).
      if (disposed) return;
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(fitAndSync, 90);
    };
    doFitRef.current = doFit;

    // Fit now, then SEED the resize dedupe with this size: the PTY is opened at
    // exactly this size (carried in the WS URL via getInitialSize), so the
    // startup resize would be redundant — sending it makes bash reprint its
    // prompt (and that redraw accumulates in the daemon scrollback, replayed on
    // every attach → the "prompt many times" artifact). A genuine later resize
    // (splitter drag) still differs from the seed and IS sent.
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }
    if (term.cols > 0 && term.rows > 0) {
      lastCols = term.cols;
      lastRows = term.rows;
    }
    doFit();
    // Auto-focus on mount so opening / switching to a session lets you type
    // immediately (TerminalArea remounts per session id) — no extra click.
    term.focus?.();
    const raf = requestAnimationFrame(doFit);
    const t = setTimeout(doFit, 120);

    // FOUT fix: xterm measures the cell using whatever font is resolved AT
    // open() time. If JetBrains Mono loads a beat later, the real (narrower)
    // glyphs leave loose gaps inside the wider fallback-measured cells. So once
    // the terminal font is loaded, force a fresh char measurement (toggle a
    // font option so xterm re-runs CharSizeService) and re-fit. Real terminal
    // only — the test fake has no such machinery.
    if (!usingFake) {
      const real = term as unknown as XTerm;
      void loadTerminalFont().then(() => {
        if (disposed) return;
        // Toggle fontSize off-and-back to force a cell re-measure (xterm only
        // re-measures on a font-option *change*), then re-fit + repaint.
        const fs = real.options.fontSize ?? 14;
        real.options.fontSize = fs + 0.01;
        real.options.fontSize = fs;
        doFit();
      });
    }

    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(doFit) : null;
    ro?.observe(el);
    // A terminal "born" at its final size (e.g. a fresh split pane) never gets a
    // ResizeObserver *change*, so its first fit can land before the layout
    // settles and leave it short. A window-resize nudge (dispatched by the
    // splitter) forces a re-fit to the real container size.
    const onWinResize = (): void => doFit();
    window.addEventListener('resize', onWinResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(t);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (fitTimer) clearTimeout(fitTimer);
      ro?.disconnect();
      window.removeEventListener('resize', onWinResize);
      termRef.current = null;
      fitRef.current = null;
      doFitRef.current = () => {};
      // Defer dispose to a macrotask so xterm's OWN pending open()-scheduled
      // timer (Viewport.syncScrollArea) fires on a still-live instance first
      // (avoids the StrictMode "reading 'dimensions'" crash).
      setTimeout(() => {
        try {
          term.dispose();
        } catch {
          // already gone
        }
      }, 0);
    };
  }, [sessionId, xtermFactory]);

  // Expose a stable PTY writer to the parent (for the file tree / drag-drop to
  // insert paths or commands). Registered on mount, cleared on unmount.
  useEffect(() => {
    if (!registerInput) return;
    registerInput((text: string) => sendInputRef.current(text));
    return () => registerInput(null);
  }, [registerInput, sessionId]);

  // Re-fit when the PTY socket OPENS: the very first fit on mount happens before
  // the socket connects, so its resize is dropped and the daemon stays at the
  // default 80x24. On open we re-fit, which schedules a (deduped) resize push of
  // the real cols/rows to the daemon.
  useEffect(() => {
    if (state !== 'open') return;
    doFitRef.current();
    // Run the split's initial command once, after the shell is up + sized.
    if (initialCommand && !cmdSentRef.current) {
      cmdSentRef.current = true;
      sendInput(`${initialCommand}\r`);
    }
  }, [state, initialCommand, sendInput]);

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-session-id={sessionId}
      style={{ backgroundColor: TERMINAL_BG, padding: '8px 10px' }}
    >
      <div
        ref={containerRef}
        data-testid="terminal"
        role="presentation"
        className="h-full w-full"
      />
      {state === 'exited' ? (
        <div
          data-testid="terminal-status"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-3 py-1.5 text-xs text-white"
        >
          Process exited — the session has ended.
        </div>
      ) : state !== 'open' ? (
        <div
          data-testid="terminal-status"
          className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white"
        >
          {state === 'connecting' ? 'connecting…' : 'reconnecting…'}
        </div>
      ) : null}
    </div>
  );
}
