/**
 * Calm display map for agent lists (herdr-aligned shell plan §3.7).
 * Wire status stays rich; list "loudness" is presentation-only.
 *
 * Every status has an affirmative word — including Idle. Omitting the word for
 * quiet agents made "no status" read as unknown, not ready.
 */
import type { Status } from './status.js';

export type DisplayStatusKind = 'blocked' | 'error' | 'working' | 'done' | 'idle' | 'disconnected';

export interface DisplayStatus {
  kind: DisplayStatusKind;
  /** Always-shown short word (Idle / Working / Needs you / …). */
  label: string;
  /**
   * True when the word should use attention styling (pulse / stronger weight).
   * Idle is affirmative but not loud.
   */
  loud: boolean;
}

const MAP: Record<Status, DisplayStatus> = {
  awaiting_input: { kind: 'blocked', label: 'Needs you', loud: true },
  error: { kind: 'error', label: 'Error', loud: true },
  running: { kind: 'working', label: 'Working', loud: true },
  starting: { kind: 'working', label: 'Starting', loud: true },
  done: { kind: 'done', label: 'Done', loud: true },
  idle: { kind: 'idle', label: 'Idle', loud: false },
  disconnected: { kind: 'disconnected', label: 'Disconnected', loud: true },
};

/** Map a wire Status to calm list presentation. */
export function displayStatus(status: Status): DisplayStatus {
  return MAP[status];
}

/** Affirmative status word for any status (Idle is never blank). */
export function statusWord(status: Status): string {
  return displayStatus(status).label;
}

/** Whether the agent is currently executing or starting work. */
export function isWorkingDisplayStatus(status: Status): boolean {
  return status === 'running' || status === 'starting';
}

/**
 * Attention-only word, or null when the status is quiet (idle).
 * Prefer {@link statusWord} when you always want a visible label.
 */
export function loudStatusWord(status: Status): string | null {
  const d = displayStatus(status);
  return d.loud ? d.label : null;
}
