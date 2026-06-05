/**
 * US-17 — Codex translator contract test (spec §7.1; spec §9 US-17).
 *
 * Acceptance (spec §9 US-17, analogous to US-16):
 *   "Recorded Codex payloads map to the correct StatusEnum per §7.1;
 *    pure-function unit tests cover every event."
 *
 * Each case loads a RECORDED Codex hook payload from `__fixtures__/codex/*.json`
 * (modeled on the shared `CodexHookPayload` shape) and asserts the pure
 * {@link translateCodexHook} function derives the status mandated by spec §7.1:
 *
 *   PreToolUse                           -> running
 *   PostToolUse (success / exit 0)       -> running
 *   PostToolUse (failure / nonzero exit) -> error
 *   PermissionRequest                    -> awaiting_input   (the money state)
 *   TurnComplete (turn-complete+quiet)   -> idle
 *   Stop                                 -> idle   (turn complete; done = session end)
 *
 * `disconnected` is orchestrator-derived (SSH/tunnel down, spec §7.1) and is NOT
 * produced by this translator. `starting` is not a Codex hook event in §7.1.
 * Pure function: no IO, no DB.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Status } from '@flock/shared';
import { describe, expect, it } from 'vitest';

import { translateCodexHook, CODEX_AGENT_TYPE } from './codex.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'codex');

/** Load a recorded Codex hook payload fixture as a plain JSON object. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as unknown;
}

/**
 * Every Codex event from spec §7.1, paired with its recorded fixture and the
 * StatusEnum value the translator must produce. This table IS the contract.
 */
const CASES: ReadonlyArray<{
  readonly name: string;
  readonly fixture: string;
  readonly expected: Status;
}> = [
  { name: 'PreToolUse -> running', fixture: 'pre-tool-use', expected: 'running' },
  {
    name: 'PostToolUse (success) -> running',
    fixture: 'post-tool-use-success',
    expected: 'running',
  },
  {
    name: 'PostToolUse (failure) -> error',
    fixture: 'post-tool-use-failure',
    expected: 'error',
  },
  {
    name: 'PermissionRequest -> awaiting_input',
    fixture: 'permission-request',
    expected: 'awaiting_input',
  },
  { name: 'TurnComplete -> idle', fixture: 'turn-complete', expected: 'idle' },
  { name: 'Stop -> idle (turn complete; done = session end)', fixture: 'stop', expected: 'idle' },
];

describe('Codex translator (US-17, spec §7.1) — recorded-fixture contract', () => {
  it('exposes the codex agent type tag', () => {
    expect(CODEX_AGENT_TYPE).toBe('codex');
  });

  for (const c of CASES) {
    it(`maps ${c.name}`, () => {
      const payload = fixture(c.fixture);
      const result = translateCodexHook(payload);
      expect(result).not.toBeNull();
      expect(result?.status).toBe(c.expected);
    });
  }

  it('covers every Codex event in spec §7.1 (no event left untested)', () => {
    // The §7.1 Codex column enumerates these distinct outcomes; if a new event
    // is added to the spec this guard forces a matching fixture+case.
    const covered = new Set(CASES.map((c) => c.expected));
    expect([...covered].sort()).toEqual(
      // No `done`: turn-complete (Stop) is `idle`; `done` is session-end only.
      ['awaiting_input', 'error', 'idle', 'running'].sort(),
    );
  });

  it('carries the tool name as detail on PreToolUse', () => {
    const result = translateCodexHook(fixture('pre-tool-use'));
    expect(result?.detail).toBe('shell');
  });

  it('labels the permission request in detail (drives the awaiting_input ring)', () => {
    const result = translateCodexHook(fixture('permission-request'));
    expect(result?.status).toBe('awaiting_input');
    expect(result?.detail).toBe('permission_request');
  });

  it('treats a PostToolUse with success:false as error even when exit_code is absent', () => {
    const result = translateCodexHook({ event: 'PostToolUse', success: false });
    expect(result?.status).toBe('error');
  });
});

describe('Codex translator — non-transitions', () => {
  it('returns null for a non-object / non-Codex payload (no transition)', () => {
    expect(translateCodexHook(null)).toBeNull();
    expect(translateCodexHook('nope')).toBeNull();
    // No recognizable event field (neither `hook_event_name` nor `event`). Note the
    // codex translator now TOLERATES `hook_event_name` (current codex uses it), so a
    // bare `{hook_event_name}` is a valid codex payload, not a no-transition case.
    expect(translateCodexHook({ unrelated: 'field' })).toBeNull();
    expect(translateCodexHook({ type: 'session.idle' })).toBeNull(); // OpenCode shape
  });

  it('returns null for an unknown Codex event name', () => {
    expect(translateCodexHook({ event: 'SomethingNew' })).toBeNull();
  });
});
