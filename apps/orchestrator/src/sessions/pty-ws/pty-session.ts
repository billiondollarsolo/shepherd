/**
 * PtySession — one shared, multi-subscriber attachment to a single flock-agentd
 * session's PTY, backing the `pty:<sessionId>` WebSocket channel (US-11).
 *
 * Why a shared object (FR-S6 — "two clients attach to the same session
 * concurrently and both see output"): a session is a single live PTY on the
 * daemon. If every browser tab opened its OWN attachment they would each get an
 * independent subscriber to the same PTY, duplicating control sequences. Instead
 * the orchestrator opens the PTY ONCE per session and FANS the output OUT to
 * every subscribed WebSocket; input from any client is forwarded INTO the one
 * PTY. This keeps the node a DUMB COURIER (spec §4.3/§5.1): the fan-out, the
 * resume buffer, and the reference counting all live here on the orchestrator.
 *
 * Reconnect resume (US-11 — "reconnect resumes"): the agent keeps producing
 * output while a viewer is away (the work never stops, PRD §1). When a client
 * (re)subscribes we replay the most recent bytes from a bounded ring buffer so
 * the terminal is not blank on reconnect. The buffer is COARSE by design — it is
 * a "recent scrollback" cushion, not a full transcript (the spec's reconcile
 * model is explicitly coarse, §7.2 / §14.4); the daemon owns the authoritative
 * scrollback.
 *
 * Lifecycle: the underlying PTY is opened lazily on the FIRST subscriber and
 * closed (detached) when the LAST subscriber leaves, so an unwatched session
 * costs nothing. The daemon session itself is NOT killed on detach — only the
 * orchestrator's attachment is released; the daemon keeps the agent alive (NFR-AV1).
 */
import type { NodeTransport, PtyExit, PtyHandle } from '../../nodes/transport/transport.js';

/** UTF-8 locale for the PTY so multibyte glyphs/box-drawing render correctly. */
const PTY_UTF8_LOCALE: Readonly<Record<string, string>> = {
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
};

/** Default number of recent output bytes retained for reconnect-resume. */
export const DEFAULT_RESUME_BUFFER_BYTES = 256 * 1024;

/**
 * Alternate-screen switch sequences (DEC private modes). 1049 is modern (save +
 * switch + clear); 47/1047 are legacy. The leading `\x1b[?` disambiguates 47 from
 * 1047/1049, so a plain substring search is safe. Mirrors agentd's session.go.
 */
const ALT_ENTER_BUFS = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'].map((s) =>
  Buffer.from(s, 'latin1'),
);
const ALT_EXIT_BUFS = ['\x1b[?1049l', '\x1b[?1047l', '\x1b[?47l'].map((s) =>
  Buffer.from(s, 'latin1'),
);
/** Put a (re)attaching client into a CLEAN alt buffer; the program then repaints. */
const ALT_CLEAN_ENTER = Buffer.from('\x1b[?1049h\x1b[H\x1b[2J', 'latin1');
/** Trailing bytes kept to catch a switch sequence split across two chunks (8-byte seq → 7). */
const ALT_CARRY_LEN = 7;

/**
 * Returns the portion of `buf` AFTER its last alt-screen-exit sequence, so the
 * stale alt frames preceding it aren't retained in the resume ring. Mirrors
 * agentd's tailAfterAltExit.
 */
function tailAfterAltExit(buf: Buffer): Buffer {
  let end = -1;
  for (const x of ALT_EXIT_BUFS) {
    const i = buf.lastIndexOf(x);
    if (i >= 0 && i + x.length > end) end = i + x.length;
  }
  return end < 0 ? buf : buf.subarray(end);
}

/** Default PTY viewport used when the first subscriber does not specify one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** A subscriber's callbacks. Output chunks are delivered as raw bytes. */
export interface PtySubscriber {
  /** Called with each chunk of PTY output (utf-8 bytes). */
  onData(chunk: Buffer): void;
  /** Called once when the underlying PTY exits (the session's program ended). */
  onExit?(event: PtyExit): void;
}

/** Options for {@link PtySession}. */
export interface PtySessionOptions {
  /** The session id (authoritative record id, spec §4.2) this PTY belongs to. */
  sessionId: string;
  /** Transport for the session's node (LocalTransport / SshTransport). */
  transport: NodeTransport;
  /**
   * Builds the argv that ATTACHES this session's PTY (run inside the PTY).
   * Injected so the session stays decoupled from how a node opens/attaches a PTY
   * and the node stays dumb.
   */
  attachCommand: () => string[];
  /** Working dir for the attach PTY (the session/project dir). */
  workingDir?: string;
  /** Max bytes retained for reconnect-resume (default {@link DEFAULT_RESUME_BUFFER_BYTES}). */
  resumeBufferBytes?: number;
  /** Initial PTY viewport. */
  cols?: number;
  rows?: number;
  /**
   * Optional observer of every raw output chunk (in ADDITION to subscriber
   * fan-out). Used to derive status from terminal activity (the OSC/PTY fallback,
   * US-20) without coupling the PTY to the status model.
   */
  onOutput?: (chunk: Buffer) => void;
  /**
   * Optional observer of the PTY's process exit (the agent/shell ended + the
   * daemon session is gone). Used to mark the session `done` without coupling the
   * PTY to the status model.
   */
  onExit?: (event: PtyExit) => void;
}

/** A live subscription handle; call {@link PtySubscription.close} to detach. */
export interface PtySubscription {
  close(): void;
}

/**
 * A bounded ring of the most recent output bytes. We keep a list of chunks and
 * a running byte total, trimming oldest chunks once the cap is exceeded. This is
 * O(1) amortised per write and avoids re-copying a giant buffer on every chunk.
 */
class ResumeRing {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly capacityBytes: number) {}

  push(chunk: Buffer): void {
    if (this.capacityBytes <= 0) return;
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.capacityBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.total -= dropped.length;
    }
    // A single chunk larger than the whole buffer: keep only its tail.
    if (this.chunks.length === 1 && this.total > this.capacityBytes) {
      const only = this.chunks[0]!;
      const tail = only.subarray(only.length - this.capacityBytes);
      this.chunks = [tail];
      this.total = tail.length;
    }
  }

  snapshot(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(this.chunks, this.total);
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}

export class PtySession {
  readonly sessionId: string;

  private readonly transport: NodeTransport;
  private readonly attachCommand: () => string[];
  private readonly workingDir?: string;
  private readonly onOutput?: (chunk: Buffer) => void;
  private readonly onExitObserver?: (event: PtyExit) => void;
  private readonly resume: ResumeRing;

  private cols: number;
  private rows: number;

  /**
   * Whether the foreground program is on the ALTERNATE screen (vim/htop/TUI),
   * derived from the output stream. When true we must NOT replay the raw resume
   * buffer on (re)attach — it's frame redraws sized to the old viewport and the
   * alt-enter may have scrolled out — so we send a clean alt-buffer reset instead
   * and let the program repaint itself (agentd forces a SIGWINCH on re-attach).
   */
  private inAlt = false;
  private altCarry: Buffer = Buffer.alloc(0);

  /** The single shared PTY attachment; null until the first subscriber opens it. */
  private pty: PtyHandle | null = null;
  /** In-flight openPty promise, so concurrent first subscribers share one open. */
  private opening: Promise<PtyHandle> | null = null;
  private exited: PtyExit | null = null;
  private closed = false;

  private readonly subscribers = new Set<PtySubscriber>();
  private unsubData: (() => void) | null = null;
  private unsubExit: (() => void) | null = null;

  constructor(options: PtySessionOptions) {
    this.sessionId = options.sessionId;
    this.transport = options.transport;
    this.attachCommand = options.attachCommand;
    this.workingDir = options.workingDir;
    this.onOutput = options.onOutput;
    this.onExitObserver = options.onExit;
    this.resume = new ResumeRing(options.resumeBufferBytes ?? DEFAULT_RESUME_BUFFER_BYTES);
    this.cols = options.cols ?? DEFAULT_COLS;
    this.rows = options.rows ?? DEFAULT_ROWS;
  }

  /**
   * Update {@link inAlt} from one output chunk. The LAST enter/exit in the scanned
   * window wins, so multiple toggles in one chunk resolve correctly; because the
   * state is a boolean, re-seeing a carried sequence is idempotent. A small tail is
   * carried so a switch sequence split across two chunks is still detected.
   */
  private updateAltState(buf: Buffer): void {
    const scan = this.altCarry.length > 0 ? Buffer.concat([this.altCarry, buf]) : buf;
    let lastE = -1;
    let lastX = -1;
    for (const n of ALT_ENTER_BUFS) {
      const i = scan.lastIndexOf(n);
      if (i > lastE) lastE = i;
    }
    for (const n of ALT_EXIT_BUFS) {
      const i = scan.lastIndexOf(n);
      if (i > lastX) lastX = i;
    }
    if (lastE >= 0 || lastX >= 0) this.inAlt = lastE > lastX;
    this.altCarry =
      scan.length > ALT_CARRY_LEN
        ? Buffer.from(scan.subarray(scan.length - ALT_CARRY_LEN))
        : Buffer.from(scan);
  }

  /** Number of currently-attached subscribers (for ref-count assertions/tests). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Whether a full-screen (alternate-screen) program is currently active. */
  get isAltScreen(): boolean {
    return this.inAlt;
  }

  /** Whether the underlying shared PTY is currently open. */
  get isAttached(): boolean {
    return this.pty !== null;
  }

  /**
   * Attach a subscriber. Opens the shared PTY on the first subscriber, then
   * IMMEDIATELY replays the resume buffer to THIS subscriber only (so a
   * reconnecting client repaints without disturbing the others). Returns a
   * subscription whose {@link PtySubscription.close} detaches it.
   */
  async subscribe(subscriber: PtySubscriber): Promise<PtySubscription> {
    if (this.closed) {
      throw new Error(`PtySession ${this.sessionId} is closed`);
    }

    // If the PTY already exited, deliver the recorded exit to this late joiner
    // after the resume replay, mirroring PtyHandle's late-onExit contract.
    this.subscribers.add(subscriber);

    await this.ensureOpen();

    // Replay so the (re)connecting terminal is not blank. On the NORMAL screen this
    // is the recent scrollback (the real history). On the ALTERNATE screen the raw
    // buffer is garbage (old-size frame redraws, possibly missing the alt-enter), so
    // we send a clean alt-buffer reset and let the program repaint itself — agentd
    // forces a SIGWINCH on re-attach so it does. Mirrors agentd's Subscribe().
    const backlog = this.inAlt ? ALT_CLEAN_ENTER : this.resume.snapshot();
    if (backlog.length > 0) {
      subscriber.onData(backlog);
    }
    // On the ALTERNATE screen, force the TUI (htop/vim/opencode/claude) to fully
    // relayout+repaint NOW. A same-size SIGWINCH only makes a diff-renderer repaint
    // changed cells (→ blank or garbled screens on reattach). A single row jiggle is
    // also NOT enough for some TUIs (OpenCode): they ignore 40→39→40 after already
    // painting at 40. Jiggle BOTH dims with longer gaps so the size sequence is a
    // real layout change, then restore. Bypass resize()'s same-size dedup.
    //
    // Also run when we *suspect* alt (inAlt) OR when the resume ring is empty after
    // ALT_CLEAN_ENTER — otherwise the client stays on a wiped alt buffer forever.
    if (this.inAlt && this.pty && this.rows > 1 && this.cols > 1) {
      const pty = this.pty;
      const cols = this.cols;
      const rows = this.rows;
      const rowJ = Math.max(1, rows - 1);
      const colJ = Math.max(1, cols - 1);
      pty.resize(cols, rowJ);
      setTimeout(() => {
        if (this.pty !== pty || this.closed) return;
        pty.resize(colJ, rows);
        setTimeout(() => {
          if (this.pty !== pty || this.closed) return;
          pty.resize(cols, rows);
        }, 100);
      }, 100);
    }
    if (this.exited && subscriber.onExit) {
      const recorded = this.exited;
      queueMicrotask(() => subscriber.onExit?.(recorded));
    }

    let detached = false;
    return {
      close: () => {
        if (detached) return;
        detached = true;
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0) {
          this.detachPty();
        }
      },
    };
  }

  /**
   * Forward input bytes from a client INTO the shared PTY (US-11 — "forwards
   * input"). Safe to call before the PTY is open (the open is awaited) and after
   * exit (silently dropped).
   */
  async write(data: Buffer | string): Promise<void> {
    if (this.closed || this.exited) return;
    const pty = await this.ensureOpen();
    pty.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  /**
   * Resize the shared PTY viewport. The LAST resize wins across clients; this is
   * a deliberate simplification (FR-S6 lets two clients share one terminal, and
   * one PTY has one size). Persisted so a later (re)open uses it.
   */
  async resize(cols: number, rows: number): Promise<void> {
    const c = Math.max(1, cols);
    const r = Math.max(1, rows);
    // Dedup: skip an unchanged size so we never trigger a redundant SIGWINCH on
    // the node PTY (which makes a shell reprint its prompt — that redraw lands in
    // the daemon scrollback and replays on every reconnect). The daemon dedups
    // too; this also avoids the needless round-trip.
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    if (this.pty) this.pty.resize(c, r);
  }

  /**
   * Release the orchestrator's attachment AND drop all subscribers. Does NOT kill
   * the daemon session — the agent keeps running (NFR-AV1). Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    this.detachPty();
    this.resume.clear();
  }

  /** Opens the shared PTY exactly once; concurrent callers share the open. */
  private async ensureOpen(): Promise<PtyHandle> {
    if (this.pty) return this.pty;
    if (this.opening) return this.opening;

    this.opening = (async () => {
      const handle = await this.transport.openPty({
        command: this.attachCommand(),
        cwd: this.workingDir,
        cols: this.cols,
        rows: this.rows,
        // Attach under a UTF-8 locale so the PTY renders multibyte glyphs
        // (box-drawing, block-element logos, `…`, Powerline icons) instead of
        // mangling them on a POSIX-locale node. See PTY_UTF8_LOCALE.
        env: PTY_UTF8_LOCALE,
      });

      this.pty = handle;
      this.exited = null;

      this.unsubData = handle.onData((chunk) => {
        const buf = Buffer.from(chunk, 'utf8');
        const wasAlt = this.inAlt;
        this.updateAltState(buf);
        if (wasAlt && !this.inAlt) {
          // Program LEFT the alt screen (quit htop/vim): the stale alt frames in the
          // resume ring would replay as garbage on a normal-screen reattach. Reset to
          // a clean screen + keep only this chunk's post-exit tail. Live subscribers
          // still get the FULL chunk below. Mirrors agentd Session.broadcast.
          this.resume.clear();
          this.resume.push(Buffer.from('\x1b[?1049l\x1b[2J\x1b[3J\x1b[H', 'latin1'));
          this.resume.push(tailAfterAltExit(buf));
        } else {
          this.resume.push(buf);
        }
        // Status-from-activity tap (OSC/PTY fallback, US-20) — best-effort, never
        // let it break the subscriber fan-out.
        try {
          this.onOutput?.(buf);
        } catch {
          /* status derivation is best-effort */
        }
        for (const sub of [...this.subscribers]) {
          sub.onData(buf);
        }
      });

      this.unsubExit = handle.onExit((event) => {
        this.exited = event;
        try {
          this.onExitObserver?.(event); // status tap (mark session 'done')
        } catch {
          /* status derivation is best-effort */
        }
        for (const sub of [...this.subscribers]) {
          sub.onExit?.(event);
        }
      });

      return handle;
    })();

    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  /** Tear down the shared PTY (kill the attach client only) and its listeners. */
  private detachPty(): void {
    this.unsubData?.();
    this.unsubExit?.();
    this.unsubData = null;
    this.unsubExit = null;
    if (this.pty) {
      // Killing the ATTACH PTY ends only this orchestrator's subscription to the
      // daemon session; the daemon + the agent inside it survive (NFR-AV1).
      this.pty.kill();
      this.pty = null;
    }
  }
}
