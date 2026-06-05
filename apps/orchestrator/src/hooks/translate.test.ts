/**
 * US-15 support — minimal hook event → status translation (spec §7.1).
 *
 * The endpoint (US-15) needs to map an incoming hook event onto a
 * {@link Status} so it can update the in-memory map. The full, exhaustive
 * per-agent contract tests are US-16 (Claude) / US-17 (Codex) / US-18
 * (OpenCode); this covers the core mappings US-15 depends on and the
 * "no transition" fallthrough. Pure function: no IO, no DB.
 */
import { describe, expect, it } from 'vitest';

import { translateHookEvent } from './translate.js';

describe('translateHookEvent — Claude Code (spec §7.1)', () => {
  const claude = (body: Record<string, unknown>) => translateHookEvent(body, 'claude-code');

  it('SessionStart -> starting', () => {
    expect(claude({ hook_event_name: 'SessionStart' })?.status).toBe('starting');
  });

  it('PreToolUse / PostToolUse -> running', () => {
    expect(claude({ hook_event_name: 'PreToolUse' })?.status).toBe('running');
    expect(claude({ hook_event_name: 'PostToolUse' })?.status).toBe('running');
  });

  it('Notification:permission_prompt -> awaiting_input', () => {
    expect(
      claude({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })?.status,
    ).toBe('awaiting_input');
  });

  it('Notification:idle_prompt -> idle', () => {
    expect(
      claude({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })?.status,
    ).toBe('idle');
  });

  it('Stop -> idle (turn complete; done = session end)', () => {
    expect(claude({ hook_event_name: 'Stop' })?.status).toBe('idle');
  });

  it('StopFailure -> error', () => {
    expect(claude({ hook_event_name: 'StopFailure' })?.status).toBe('error');
  });

  it('PostToolUse with nonzero exit code -> error', () => {
    expect(
      claude({ hook_event_name: 'PostToolUse', tool_response_exit_code: 1 })?.status,
    ).toBe('error');
  });
});

describe('translateHookEvent — Codex (spec §7.1)', () => {
  const codex = (body: Record<string, unknown>) => translateHookEvent(body, 'codex');

  it('PreToolUse / PostToolUse -> running', () => {
    expect(codex({ event: 'PreToolUse' })?.status).toBe('running');
    expect(codex({ event: 'PostToolUse' })?.status).toBe('running');
  });

  it('PermissionRequest -> awaiting_input', () => {
    expect(codex({ event: 'PermissionRequest' })?.status).toBe('awaiting_input');
  });

  it('TurnComplete -> idle; Stop -> idle (turn complete; done = session end)', () => {
    expect(codex({ event: 'TurnComplete' })?.status).toBe('idle');
    expect(codex({ event: 'Stop' })?.status).toBe('idle');
  });

  it('PostToolUse failure (success:false) -> error', () => {
    expect(codex({ event: 'PostToolUse', success: false })?.status).toBe('error');
  });
});

describe('translateHookEvent — OpenCode (spec §7.1)', () => {
  const oc = (body: Record<string, unknown>) => translateHookEvent(body, 'opencode');

  it('session.idle -> idle', () => {
    expect(oc({ type: 'session.idle' })?.status).toBe('idle');
  });

  it('permission.request / question.ask -> awaiting_input', () => {
    expect(oc({ type: 'permission.request' })?.status).toBe('awaiting_input');
    expect(oc({ type: 'question.ask' })?.status).toBe('awaiting_input');
  });

  it('session.error -> error; session.complete -> done', () => {
    expect(oc({ type: 'session.error' })?.status).toBe('error');
    expect(oc({ type: 'session.complete' })?.status).toBe('done');
  });
});

describe('translateHookEvent — no recognized mapping', () => {
  it('returns null for an unrecognized payload (no transition)', () => {
    expect(translateHookEvent({ totally: 'unknown' })).toBeNull();
    expect(translateHookEvent({ hook_event_name: 'Mystery' }, 'claude-code')).toBeNull();
    expect(translateHookEvent(null)).toBeNull();
    expect(translateHookEvent('not-an-object')).toBeNull();
  });

  it('returns null for hook-less session types (generic, terminal)', () => {
    // A generic agent reports via OSC/PTY and a terminal reports nothing — this
    // endpoint has no structured payload to translate for either.
    expect(translateHookEvent({ any: 'payload' }, 'generic')).toBeNull();
    expect(translateHookEvent({ any: 'payload' }, 'terminal')).toBeNull();
  });

  it('infers the agent from the payload shape when agentType is omitted', () => {
    // Claude shape (hook_event_name) is recognized without an explicit agentType.
    // Stop = turn complete = idle (done is session-end only).
    expect(translateHookEvent({ hook_event_name: 'Stop' })?.status).toBe('idle');
    // Codex shape (event) likewise.
    expect(translateHookEvent({ event: 'Stop' })?.status).toBe('idle');
    // OpenCode shape (type) — session.complete IS a genuine session end → done.
    expect(translateHookEvent({ type: 'session.complete' })?.status).toBe('done');
  });
});
