/**
 * E2E harness entry (US-12 Playwright smoke).
 *
 * Mounts the real <Terminal> bound to a fake in-page WebSocket so the smoke can
 * prove the acceptance criteria WITHOUT the not-yet-built session-routing app
 * shell (US-30/US-33) and without a live orchestrator:
 *
 *   - selecting a session mounts xterm.js bound to `pty:<id>`
 *   - typing echoes (keystrokes captured + echoed back into the terminal)
 *   - alt-screen apps (vim/htop) work — we feed the alt-screen enter sequence
 *     (CSI ?1049h) plus text and assert the emulator renders it.
 *
 * Only used by the e2e smoke; it is imported via `?harness` URLs Playwright
 * navigates to and is excluded from the production entry (main.tsx).
 */
import { createRoot } from 'react-dom/client';
import Terminal from './Terminal';
import type { WsLike } from './usePtyWebSocket';
import '../../styles/terminal-fonts';
import './harness.css';

declare global {
  interface Window {
    /** Captured keystrokes the page sent upstream (for the smoke to assert echo). */
    __ptySent: string[];
    /** Push raw bytes "from the server" into the terminal (drives output tests). */
    __ptyEmit: (text: string) => void;
  }
}

const encoder = new TextEncoder();

/**
 * A fake WebSocket that loops keystrokes back as terminal output (server-side
 * echo, exactly what a real PTY does) and exposes a hook to inject arbitrary
 * output (e.g. alt-screen escape sequences).
 */
class HarnessWs implements WsLike {
  binaryType = 'blob';
  readyState = 1; // OPEN immediately
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | ArrayBufferView | string }) => void) | null = null;

  constructor(readonly url: string) {
    window.__ptySent = [];
    window.__ptyEmit = (text: string) => this.emit(text);
    // Fire open on next tick so React effect handlers are registered.
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (typeof data === 'string') return; // resize envelope; ignore
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          );
    const text = new TextDecoder().decode(bytes);
    window.__ptySent.push(text);
    // Echo back like a real PTY so typing appears in the terminal.
    this.emit(text);
  }

  emit(text: string): void {
    this.onmessage?.({ data: encoder.encode(text).buffer });
  }

  close(): void {
    this.readyState = 3;
  }
}

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <div style={{ position: 'fixed', inset: 0 }}>
      <Terminal sessionId="e2e-session" wsFactory={(url) => new HarnessWs(url)} />
    </div>,
  );
}
