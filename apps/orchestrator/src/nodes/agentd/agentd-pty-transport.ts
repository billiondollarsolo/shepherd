/**
 * AgentdPtyTransport — adapts one flock-agentd session to the orchestrator's
 * {@link PtyHandle}/{@link NodeTransport} contract, so the EXISTING
 * PtySessionRegistry / PtySession (fan-out, resume buffer, linger, OSC status
 * tap) work unchanged — the bytes come from the daemon's raw PTY.
 *
 * It is per-session: `resolve(sessionId)` builds one of these bound to that
 * session id + spec, so `openPty()` (which carries no id) knows which daemon
 * session to open/subscribe. A `StringDecoder` reassembles multibyte UTF-8 across
 * chunk boundaries (PtySession re-encodes the string back to bytes), matching
 * node-pty's behaviour so glyphs/box-drawing never split.
 */
import { StringDecoder } from 'node:string_decoder';

import type {
  ExecResult,
  NodeTransport,
  OpenPtyOptions,
  PtyExit,
  PtyHandle,
} from '../transport/transport.js';
import type { AgentdSessionSpec, NodeAgentdClient } from './agentd-client.js';

export class AgentdPtyTransport implements NodeTransport {
  readonly kind = 'local' as const; // informational; the bytes are daemon-sourced

  /**
   * @param opts.attachOnly when true, openPty does NOT create the daemon session
   *   (no `open`), it only subscribes to one the LAUNCH already created. This is
   *   the attach path for agent/terminal sessions and avoids the create/attach
   *   race that would otherwise spawn a stray default shell labelled "agent".
   *   Leave false for `:shell` split panes, which the attach path legitimately
   *   creates on demand (they have no separate launch).
   */
  constructor(
    private readonly client: NodeAgentdClient,
    private readonly spec: AgentdSessionSpec,
    private readonly opts: { attachOnly?: boolean } = {},
  ) {}

  async exec(): Promise<ExecResult> {
    throw new Error('AgentdPtyTransport: exec is not supported (PTY only)');
  }

  async dispose(): Promise<void> {
    // The NodeAgentdClient is shared per node and owned elsewhere; nothing to do.
  }

  async openPty(options?: OpenPtyOptions): Promise<PtyHandle> {
    const spec: AgentdSessionSpec = {
      ...this.spec,
      cols: options?.cols ?? this.spec.cols,
      rows: options?.rows ?? this.spec.rows,
    };
    // attachOnly: the launch is the sole creator (agent/terminal sessions); we
    // only subscribe. Otherwise (e.g. :shell splits) create-or-get the session,
    // opening it at the client's size so a fresh shell needs no startup resize.
    if (!this.opts.attachOnly) {
      await this.client.open(spec);
    } else if (spec.cols && spec.rows) {
      // The agent/terminal session was spawned at launch (80x24) before any
      // browser; size its PTY to the attaching client now, so the client's own
      // startup resize is redundant (deduped) — no extra SIGWINCH / reflow.
      this.client.resize(spec.id, spec.cols, spec.rows);
    }

    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(event: PtyExit) => void>();
    let exited: PtyExit | null = null;
    const decoder = new StringDecoder('utf8');

    const sub = this.client.subscribe(
      spec.id,
      (buf) => {
        const s = decoder.write(buf);
        if (s.length === 0) return;
        for (const l of [...dataListeners]) l(s);
      },
      (code, reason) => {
        // A daemon-link drop is TRANSIENT (the agent persists) → the bridge
        // reconnects instead of declaring the session dead. A real `exit` frame
        // is terminal.
        exited = { exitCode: code, signal: null, transient: reason === 'disconnect' };
        for (const l of [...exitListeners]) l(exited);
      },
    );

    return {
      onData: (listener) => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit: (listener) => {
        if (exited) {
          const e = exited;
          queueMicrotask(() => listener(e));
          return () => {};
        }
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      write: (data) => this.client.write(spec.id, Buffer.from(data, 'utf8')),
      resize: (cols, rows) => this.client.resize(spec.id, cols, rows),
      // kill() here means DETACH (the PtySession releases its attachment when the
      // last browser leaves). It must NOT close the daemon session — that would
      // terminate the agent on every ws disconnect/reconnect, defeating the
      // daemon's whole purpose (persistence, NFR-AV1). Just stop streaming; the
      // daemon session + agent keep running. Explicit termination goes through the
      // terminate-session path (see AgentdPtyTransport.terminate / index wiring).
      kill: () => {
        sub.close();
      },
    };
  }

  /**
   * Explicitly terminate the daemon session (kill the agent) — wired into the
   * terminate-session flow, NOT the per-attachment kill() above.
   */
  terminate(): void {
    this.client.close(this.spec.id);
  }
}
