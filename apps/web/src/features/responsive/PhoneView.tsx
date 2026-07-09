/**
 * PhoneView — mobile Agents list + driveable stage for the paddock.
 * Stage/send injects into the real pty:<sessionId> WebSocket (same framing as desktop).
 */
import { useMemo, useState } from 'react';
import type { Status } from '@flock/shared';
import { loudStatusWord } from '@flock/shared';
import { sortSessionsByAttention } from '../tree/ordering';
import { usePaddock } from '../../store/paddock';
import { StatusDot } from '../../components/StatusDot';
import { sendPhoneInject } from './phoneInject';

const ATTENTION_STATUSES: ReadonlySet<Status> = new Set<Status>(['awaiting_input', 'error']);

function needsAttention(status: Status): boolean {
  return ATTENTION_STATUSES.has(status);
}

export interface PhoneSession {
  readonly id: string;
  readonly label: string;
  readonly status: Status;
  readonly projectId?: string;
}

export interface PhoneViewProps {
  readonly sessions: readonly PhoneSession[];
  readonly onSelectSession?: (sessionId: string) => void;
  /**
   * Optional override for tests. Production uses {@link sendPhoneInject} into pty WS.
   */
  readonly onSendInput?: (sessionId: string, text: string, submit: boolean) => void | Promise<void>;
}

const STATUS_LABEL: Record<Status, string> = {
  starting: 'Starting',
  running: 'Running',
  awaiting_input: 'Needs you',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  disconnected: 'Disconnected',
};

function statusDotVar(status: Status): string {
  const key = status === 'awaiting_input' ? 'awaiting' : status;
  return `var(--flock-status-${key})`;
}

function SessionRow({
  session,
  onSelectSession,
}: {
  session: PhoneSession;
  onSelectSession?: (id: string) => void;
}): JSX.Element {
  const rings = needsAttention(session.status);
  const loud = loudStatusWord(session.status);

  return (
    <li
      data-testid="phone-session"
      data-session-id={session.id}
      data-status={session.status}
      className="flex flex-col gap-2 border-b border-flock-muted/15 px-4 py-3"
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        onClick={() => onSelectSession?.(session.id)}
      >
        <span
          className={`size-2.5 shrink-0 rounded-full ${rings ? 'animate-pulse' : ''}`}
          style={{ background: statusDotVar(session.status) }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-flock-ink-primary">{session.label}</div>
          <div className="text-2xs text-flock-ink-muted">
            {loud ?? STATUS_LABEL[session.status]}
          </div>
        </div>
        <StatusDot status={session.status} />
      </button>
    </li>
  );
}

const KEY_STRIP: ReadonlyArray<{ label: string; seq: string }> = [
  { label: 'Esc', seq: '\u001b' },
  { label: 'Tab', seq: '\t' },
  { label: '↑', seq: '\u001b[A' },
  { label: '↓', seq: '\u001b[B' },
  { label: 'Enter', seq: '\r' },
  { label: 'Ctrl-C', seq: '\u0003' },
];

function PhoneStage({
  session,
  onBack,
  onSendInput,
}: {
  session: PhoneSession;
  onBack: () => void;
  onSendInput: (sessionId: string, text: string, submit: boolean) => void | Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async (text: string, submit: boolean): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await onSendInput(session.id, text, submit);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-flock-bg" data-testid="phone-stage">
      <header className="flex items-center gap-2 border-b border-[var(--flock-border)] px-3 py-2">
        <button type="button" className="text-sm text-flock-accent" onClick={onBack}>
          ← Agents
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{session.label}</div>
        <span className="text-2xs text-flock-ink-muted">{STATUS_LABEL[session.status]}</span>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-flock-ink-muted">
        <p>Drive this agent from the paddock command bar.</p>
        <p className="text-2xs">Input is sent to the agent terminal (pty) on this session.</p>
        {err ? <p className="text-2xs text-status-error">{err}</p> : null}
      </div>
      <div className="flex flex-wrap gap-1 border-t border-[var(--flock-border)] px-2 py-1.5" data-testid="phone-key-strip">
        {KEY_STRIP.map((k) => (
          <button
            key={k.label}
            type="button"
            disabled={busy}
            className="rounded border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1 text-2xs disabled:opacity-50"
            onClick={() => void send(k.seq, false)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 border-t border-[var(--flock-border)] p-2">
        <textarea
          data-testid="phone-stage-input"
          aria-label="Agent command"
          className="min-h-[2.5rem] flex-1 resize-none rounded border border-[var(--flock-border)] bg-flock-surface-1 px-2 py-1.5 text-sm"
          placeholder="Message the agent…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
        />
        <div className="flex flex-col gap-1">
          <button
            type="button"
            data-testid="phone-stage-btn"
            disabled={busy || !draft}
            className="rounded bg-flock-surface-2 px-3 py-1.5 text-2xs font-medium disabled:opacity-50"
            onClick={() => void send(draft, false)}
          >
            Stage
          </button>
          <button
            type="button"
            data-testid="phone-send-btn"
            disabled={busy}
            className="rounded bg-flock-accent px-3 py-1.5 text-2xs font-medium text-white disabled:opacity-50"
            onClick={() => {
              void send(draft || '', true).then(() => setDraft(''));
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export function PhoneView({ sessions, onSelectSession, onSendInput }: PhoneViewProps): JSX.Element {
  const openAgent = usePaddock((s) => s.openAgent);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectSession = usePaddock((s) => s.selectSession);

  const inject =
    onSendInput ??
    ((sessionId: string, text: string, submit: boolean) => sendPhoneInject(sessionId, text, submit));

  const ordered = useMemo(
    () =>
      sortSessionsByAttention(sessions.map((s) => ({ id: s.id, status: s.status })))
        .map((o) => sessions.find((s) => s.id === o.id)!)
        .filter(Boolean),
    [sessions],
  );

  const selected = selectedSessionId
    ? sessions.find((s) => s.id === selectedSessionId) ?? null
    : null;

  if (selected) {
    return (
      <PhoneStage
        session={selected}
        onBack={() => selectSession(null)}
        onSendInput={inject}
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-flock-bg" data-testid="phone-view">
      <header className="border-b border-[var(--flock-border)] px-4 py-3">
        <h1 className="text-base font-semibold text-flock-ink-primary">Agents</h1>
        <p className="text-2xs text-flock-ink-muted">Paddock away view · tap to drive</p>
      </header>
      {ordered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-flock-ink-muted">
          All clear — no agents in the paddock.
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {ordered.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              onSelectSession={(id) => {
                const sess = sessions.find((x) => x.id === id);
                openAgent(id, sess?.projectId);
                onSelectSession?.(id);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default PhoneView;
