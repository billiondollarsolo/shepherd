/**
 * PtySessionRegistry — the orchestrator-wide map from `sessionId` → the single
 * shared {@link PtySession} for that session (US-11, FR-S6).
 *
 * This is what makes "two clients attach to the same session concurrently and
 * both see output" cheap and correct: the SECOND client subscribing to
 * `pty:<sessionId>` reuses the SAME PtySession (and therefore the same one PTY
 * attachment + the same resume buffer) as the first. The registry also enforces
 * the single-authoritative-record discipline (spec §4.2): one `sessionId` keys
 * one PTY attachment.
 *
 * Reconnect-resume linger (US-11 "reconnect resumes"): when the LAST subscriber
 * detaches, the PtySession RELEASES its PTY attachment (no wasted subscriber on
 * the daemon) but the session OBJECT — and crucially its recent-output ring
 * buffer — is kept alive for a short linger window. A client that reconnects
 * within that window resumes from the buffered bytes and repaints immediately.
 * After the window with still no subscribers, the session is dropped so the
 * registry never accumulates idle state. The agent process itself is never
 * killed here (NFR-AV1) — only the orchestrator's attachment + buffer.
 */
import type { NodeTransport, PtyExit } from '../../nodes/transport/transport.js';
import {
  PtySession,
  type PtySessionOptions,
  type PtySubscriber,
  type PtySubscription,
} from './pty-session.js';

/** Default linger (ms) the resume buffer is kept after the last detach. */
export const DEFAULT_LINGER_MS = 5 * 60 * 1000;

/**
 * Resolves the transport + attach argv + working dir for a session id. Injected
 * so the registry stays decoupled from the session-create service and the DB;
 * the bridge owner wires this to look up the live session record.
 */
export interface PtySessionResolver {
  (sessionId: string): Promise<PtySessionBinding> | PtySessionBinding;
}

/** Everything needed to open a session's shared PTY (resolved per session). */
export interface PtySessionBinding {
  transport: NodeTransport;
  /** Builds the argv that ATTACHES this session's PTY (run inside the PTY). */
  attachCommand: () => string[];
  workingDir?: string;
}

/** Options for {@link PtySessionRegistry}. */
export interface PtySessionRegistryOptions {
  resolve: PtySessionResolver;
  /** Forwarded to each {@link PtySession}; bytes retained for resume. */
  resumeBufferBytes?: number;
  /**
   * How long (ms) to keep a subscriber-less session (and its resume buffer)
   * before dropping it. 0 drops immediately (no cross-disconnect resume).
   * Default {@link DEFAULT_LINGER_MS}.
   */
  lingerMs?: number;
  /**
   * Optional observer of every raw output chunk for a session (in ADDITION to
   * subscriber fan-out). Wired to the OSC/PTY status fallback (US-20).
   */
  onOutput?: (sessionId: string, chunk: Buffer) => void;
  /** Optional observer of a session's PTY process exit (mark the session done). */
  onExit?: (sessionId: string, event: PtyExit) => void;
}

/** Internal per-session bookkeeping. */
interface Entry {
  session: PtySession;
  lingerTimer: NodeJS.Timeout | null;
}

export class PtySessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly options: PtySessionRegistryOptions;
  private readonly lingerMs: number;

  constructor(options: PtySessionRegistryOptions) {
    this.options = options;
    this.lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  }

  /** Number of sessions currently tracked (live OR lingering). */
  get size(): number {
    return this.entries.size;
  }

  /** The shared PtySession for an id, if one is currently tracked. */
  peek(sessionId: string): PtySession | undefined {
    return this.entries.get(sessionId)?.session;
  }

  /**
   * Subscribe a client to `pty:<sessionId>`. Creates the shared PtySession on
   * first use and reuses it for every concurrent client (FR-S6). Cancels any
   * pending linger drop (the session is wanted again). When the last subscriber
   * detaches, the session is scheduled for a lingered drop so a quick reconnect
   * can still resume from its buffer.
   */
  async subscribe(
    sessionId: string,
    subscriber: PtySubscriber,
    /** Initial PTY size used ONLY when this call creates the session (so a fresh
     *  PTY opens at the client's size instead of the 80x24 default). */
    initialSize?: { cols: number; rows: number },
  ): Promise<PtySubscription> {
    const entry = await this.acquire(sessionId, initialSize);
    // A new subscriber means the session is wanted: cancel any linger drop.
    if (entry.lingerTimer) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }

    const inner = await entry.session.subscribe(subscriber);
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        inner.close();
        if (entry.session.subscriberCount === 0) {
          this.scheduleDrop(sessionId, entry);
        }
      },
    };
  }

  /** Forward input to a session's shared PTY (no-op if not tracked). */
  async write(sessionId: string, data: Buffer | string): Promise<void> {
    await this.entries.get(sessionId)?.session.write(data);
  }

  /** Resize a session's shared PTY (no-op if not tracked). */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.entries.get(sessionId)?.session.resize(cols, rows);
  }

  /** Close and drop a single session's attachment (does NOT kill the agent). */
  closeSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) {
      if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
      entry.session.close();
      this.entries.delete(sessionId);
    }
  }

  /** Close every tracked attachment (orchestrator shutdown). */
  closeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
      entry.session.close();
    }
    this.entries.clear();
  }

  /** Get-or-create the entry for an id, resolving its binding once. */
  private async acquire(
    sessionId: string,
    initialSize?: { cols: number; rows: number },
  ): Promise<Entry> {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;

    const binding = await this.options.resolve(sessionId);
    // Re-check after the async resolve: a concurrent subscriber may have created
    // it. First writer wins; the loser's freshly-built session is discarded.
    const raced = this.entries.get(sessionId);
    if (raced) return raced;

    const onOutput = this.options.onOutput;
    const onExit = this.options.onExit;
    const sessionOptions: PtySessionOptions = {
      sessionId,
      transport: binding.transport,
      attachCommand: binding.attachCommand,
      workingDir: binding.workingDir,
      resumeBufferBytes: this.options.resumeBufferBytes,
      cols: initialSize?.cols,
      rows: initialSize?.rows,
      onOutput: onOutput ? (chunk) => onOutput(sessionId, chunk) : undefined,
      onExit: onExit ? (event) => onExit(sessionId, event) : undefined,
    };
    const entry: Entry = { session: new PtySession(sessionOptions), lingerTimer: null };
    this.entries.set(sessionId, entry);
    return entry;
  }

  /** Schedule (or immediately perform) the subscriber-less drop. */
  private scheduleDrop(sessionId: string, entry: Entry): void {
    if (entry.lingerTimer) return;
    if (this.lingerMs <= 0) {
      entry.session.close();
      this.entries.delete(sessionId);
      return;
    }
    entry.lingerTimer = setTimeout(() => {
      // Only drop if still subscriber-less (a reconnect may have arrived).
      if (entry.session.subscriberCount === 0 && this.entries.get(sessionId) === entry) {
        entry.session.close();
        this.entries.delete(sessionId);
      }
    }, this.lingerMs);
    // Do not keep the event loop alive solely for a linger drop.
    entry.lingerTimer.unref?.();
  }
}
