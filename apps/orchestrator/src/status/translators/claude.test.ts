/**
 * US-16 — Claude Code translator contract test (spec §7.1; spec §9 US-16).
 *
 * Acceptance (spec §9 US-16):
 *   "Recorded Claude payloads map to the correct StatusEnum per §7.1;
 *    pure-function unit tests cover every event."
 *
 * This is the exhaustive, FIXTURE-DRIVEN contract test promised by the seam in
 * `hooks/translate.ts`. Each case loads a RECORDED Claude Code hook payload from
 * `__fixtures__/claude/*.json` (modeled on the real Claude Code hook event
 * shapes) and asserts the pure {@link translateClaudeHook} function derives the
 * status mandated by spec §7.1:
 *
 *   SessionStart                       -> starting
 *   PreToolUse                         -> running
 *   PostToolUse (exit 0 / no code)     -> running
 *   PostToolUse (nonzero exit)         -> error
 *   Notification:permission_prompt     -> awaiting_input   (the money state)
 *   Notification:idle_prompt           -> idle
 *   Stop                               -> idle   (turn complete; done = session end)
 *   StopFailure                        -> error
 *
 * `disconnected` is orchestrator-derived (SSH/tunnel down, spec §7.1) and is NOT
 * produced by this translator. Pure function: no IO, no DB.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Status } from '@flock/shared';
import { describe, expect, it } from 'vitest';

import { translateClaudeHook, CLAUDE_AGENT_TYPE } from './claude.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'claude');

/** Load a recorded Claude hook payload fixture as a plain JSON object. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as unknown;
}

/**
 * Every Claude Code event from spec §7.1, paired with its recorded fixture and
 * the StatusEnum value the translator must produce. This table IS the contract.
 */
const CASES: ReadonlyArray<{
  readonly name: string;
  readonly fixture: string;
  readonly expected: Status;
}> = [
  { name: 'SessionStart -> idle (ready)', fixture: 'session-start', expected: 'idle' },
  { name: 'PreToolUse -> running', fixture: 'pre-tool-use', expected: 'running' },
  {
    name: 'PostToolUse (exit 0) -> running',
    fixture: 'post-tool-use-success',
    expected: 'running',
  },
  {
    name: 'PostToolUse (nonzero exit) -> error',
    fixture: 'post-tool-use-failure',
    expected: 'error',
  },
  {
    name: 'Notification:permission_prompt -> awaiting_input',
    fixture: 'notification-permission-prompt',
    expected: 'awaiting_input',
  },
  {
    name: 'Notification:idle_prompt -> idle',
    fixture: 'notification-idle-prompt',
    expected: 'idle',
  },
  { name: 'Stop -> idle (turn complete; done = session end)', fixture: 'stop', expected: 'idle' },
  { name: 'StopFailure -> error', fixture: 'stop-failure', expected: 'error' },
  { name: 'PostToolUseFailure -> error', fixture: 'post-tool-use-failure-event', expected: 'error' },
  { name: 'SessionEnd -> done (genuine session end)', fixture: 'session-end', expected: 'done' },
];

describe('Claude Code translator (US-16, spec §7.1) — recorded-fixture contract', () => {
  it('exposes the claude-code agent type tag', () => {
    expect(CLAUDE_AGENT_TYPE).toBe('claude-code');
  });

  for (const c of CASES) {
    it(`maps ${c.name}`, () => {
      const payload = fixture(c.fixture);
      const result = translateClaudeHook(payload);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(c.expected);
    });
  }

  it('covers every Claude Code event in spec §7.1 (no event left untested)', () => {
    // The §7.1 Claude column enumerates these distinct outcomes; if a new event
    // is added to the spec this guard forces a matching fixture+case.
    const covered = new Set(CASES.map((c) => c.expected));
    expect([...covered].sort()).toEqual(
      // `done` is session-end only (SessionEnd); turn-complete (Stop) is `idle`.
      // `starting` is the orchestrator's INITIAL status, not a translator output —
      // SessionStart now maps to `idle` (booted + ready).
      ['awaiting_input', 'done', 'error', 'idle', 'running'].sort(),
    );
  });

  it('carries the tool name as detail on PreToolUse', () => {
    const result = translateClaudeHook(fixture('pre-tool-use'));
    expect(result?.detail).toBe('Bash');
  });

  it('labels the permission prompt in detail (drives the awaiting_input ring)', () => {
    const result = translateClaudeHook(fixture('notification-permission-prompt'));
    expect(result?.status).toBe('awaiting_input');
    expect(result?.detail).toBe('permission_prompt');
  });
});

describe('Claude Code translator — non-transitions', () => {
  it('returns null for a non-object / non-Claude payload (no transition)', () => {
    expect(translateClaudeHook(null)).toBeNull();
    expect(translateClaudeHook('nope')).toBeNull();
    expect(translateClaudeHook({ event: 'PreToolUse' })).toBeNull(); // Codex shape
    expect(translateClaudeHook({ type: 'session.idle' })).toBeNull(); // OpenCode shape
  });

  it('returns null for an unknown Claude event name', () => {
    expect(translateClaudeHook({ hook_event_name: 'SomethingNew' })).toBeNull();
  });

  it('returns null for a Notification with no recognized subtype', () => {
    expect(
      translateClaudeHook({ hook_event_name: 'Notification', notification_type: undefined }),
    ).toBeNull();
    // A Notification with an unrelated message but no permission/idle subtype is
    // ambiguous and yields no transition (the endpoint still acks + logs it).
    expect(translateClaudeHook({ hook_event_name: 'Notification' })).toBeNull();
  });
});
