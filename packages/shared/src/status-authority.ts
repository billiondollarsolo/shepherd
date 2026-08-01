/**
 * Status authority merge (D4 / D11) — pure functions mirroring
 * `agentd/internal/authority`. Terminal vs Chat/ACP/stream arbitration for
 * multi-source session status.
 */

/** Session run mode: native PTY vs structured transport ownership. */
export type SessionRunMode = 'terminal' | 'chat';

/**
 * True when the session mode string is a structured Chat transport
 * (chat, claude-stream, codex-app-server, acp). Case-insensitive.
 */
export function isChatMode(mode: string | undefined | null): boolean {
  if (mode == null) return false;
  switch (mode.trim().toLowerCase()) {
    case 'chat':
    case 'claude-stream':
    case 'codex-app-server':
    case 'acp':
      return true;
    default:
      return false;
  }
}

/**
 * Map screen-manifest state vocabulary to wire Status.
 * working→running, blocked→awaiting_input, idle→idle, unknown/empty→null.
 */
export function mapScreenStateToWire(state: string): string | null {
  switch (state.trim().toLowerCase()) {
    case 'working':
      return 'running';
    case 'blocked':
      return 'awaiting_input';
    case 'idle':
      return 'idle';
    case 'unknown':
    case '':
      return null;
    default:
      // Pass through already-wire values (running, awaiting_input, …).
      return state.trim();
  }
}

/** Flattened multi-source input for status arbitration. */
export interface AuthorityInput {
  /** Session mode: 'terminal' | 'chat', or a transport string (claude-stream, …). */
  mode: string;
  /** Current wire status held by the session. */
  current?: string;
  /** Full lifecycle hooks actively reporting (skips screen in terminal mode). */
  lifecycleActive?: boolean;
  /** Lifecycle / hooks state (wire status). */
  lifecycleState?: string;
  /** Structured transport state (Chat/ACP/stream). */
  transportState?: string;
  /** Screen-manifest match state (working/blocked/idle or wire). */
  screenState?: string;
  /** Screen rule asserted a visible blocker (permission UI). */
  screenVisibleBlocker?: boolean;
  /** Manifest `skip_state_update` — do not clobber wire state from screen. */
  screenSkip?: boolean;
  /** Feature flag D10: screen-manifest detection enabled. Default off. */
  screenDetectOn?: boolean;
  /** Transcript / partial integration state. */
  transcriptState?: string;
  /** PTY activity heuristic state. */
  activityState?: string;
}

export interface AuthorityDecision {
  state: string;
  source: string;
  reason: string;
}

function nonEmpty(s: string | undefined | null): string {
  if (s == null) return '';
  return s.trim();
}

function resolveMode(mode: string): SessionRunMode {
  return isChatMode(mode) || mode.trim().toLowerCase() === 'chat' ? 'chat' : 'terminal';
}

/**
 * Merge multi-source status observations into a wire status decision.
 *
 * Chat / ACP / stream (D11): transport owns status; screen is never applied.
 * Terminal (D4): lifecycle (if active) > visible_blocker screen >
 * transcript/lifecycle partial > PTY activity > idle fallback.
 * When `screenDetectOn` is false, screen is ignored entirely (D10).
 */
export function mergeStatusAuthority(input: AuthorityInput): AuthorityDecision {
  const mode = resolveMode(input.mode || 'terminal');
  const screenOn = input.screenDetectOn === true;
  const screenSkip = input.screenSkip === true;

  if (mode === 'chat') {
    const transport = nonEmpty(input.transportState);
    if (transport) {
      return {
        state: transport,
        source: 'transport',
        reason: 'chat_mode_transport_authority',
      };
    }
    const life = nonEmpty(input.lifecycleState);
    if (life) {
      return {
        state: life,
        source: 'lifecycle',
        reason: 'chat_mode_lifecycle_fallback',
      };
    }
    const cur = nonEmpty(input.current);
    if (cur) {
      return { state: cur, source: 'current', reason: 'chat_mode_hold' };
    }
    return { state: 'idle', source: 'default', reason: 'chat_mode_default_idle' };
  }

  // Terminal: full lifecycle authority skips screen
  if (input.lifecycleActive) {
    const life = nonEmpty(input.lifecycleState);
    if (life) {
      return {
        state: life,
        source: 'lifecycle',
        reason: 'lifecycle_authority_active',
      };
    }
  }

  if (screenOn && !screenSkip) {
    const wire = mapScreenStateToWire(input.screenState ?? '');
    if (input.screenVisibleBlocker || wire === 'awaiting_input') {
      return {
        state: 'awaiting_input',
        source: 'screen',
        reason: 'visible_blocker_or_blocked',
      };
    }
    if (!input.lifecycleActive) {
      if (wire === 'running') {
        return {
          state: 'running',
          source: 'screen',
          reason: 'visible_working',
        };
      }
    }
  }

  // Partial hooks / transcript (lifecycle without full authority)
  const lifePartial = nonEmpty(input.lifecycleState);
  if (lifePartial && !input.lifecycleActive) {
    return { state: lifePartial, source: 'hooks', reason: 'partial' };
  }

  const transcript = nonEmpty(input.transcriptState);
  if (transcript) {
    return { state: transcript, source: 'transcript', reason: 'partial' };
  }

  // Screen idle after partials
  if (screenOn && !screenSkip && !input.lifecycleActive) {
    const wire = mapScreenStateToWire(input.screenState ?? '');
    if (wire === 'idle') {
      return { state: 'idle', source: 'screen', reason: 'screen_idle' };
    }
  }

  const activity = nonEmpty(input.activityState);
  if (activity) {
    return { state: activity, source: 'activity', reason: 'pty_activity' };
  }

  const cur = nonEmpty(input.current);
  if (cur) {
    return { state: cur, source: 'current', reason: 'hold_current' };
  }
  return { state: 'idle', source: 'default', reason: 'idle_fallback' };
}
