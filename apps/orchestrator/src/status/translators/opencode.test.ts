/**
 * US-18 — OpenCode translator contract test (spec §7.1, §9 "TDD-first").
 *
 * Pins the OpenCode plugin event → {@link Status} mapping against RECORDED
 * fixtures (`__fixtures__/opencode/*.json`), the same shape the Flock OpenCode
 * plugin POSTs to `POST /api/hooks/:sessionId`. Mirrors the Claude (US-16) and
 * Codex (US-17) contract tests so all three first-class agents are pinned the
 * same way. Pure function: no IO, no DB.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OpenCodeHookPayload, type Status } from '@flock/shared';
import { describe, expect, it } from 'vitest';

import { OPENCODE_AGENT_TYPE, translateOpenCodeHook } from './opencode.js';

/** Loads a recorded OpenCode event fixture by name. */
function fixture(name: string): unknown {
  const url = new URL(`./__fixtures__/opencode/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

describe('translateOpenCodeHook — recorded fixtures (spec §7.1)', () => {
  // Every recorded fixture mapped to its expected status. This table is the
  // contract: each first-class OpenCode event must map exactly as the spec's
  // §7.1 OpenCode column requires.
  const cases: ReadonlyArray<readonly [fixture: string, status: Status]> = [
    ['session-start', 'starting'],
    ['tool-execute-before', 'running'],
    ['tool-execute-after-success', 'running'],
    ['tool-execute-after-failure', 'error'],
    ['permission-request', 'awaiting_input'],
    ['question-ask', 'awaiting_input'],
    ['session-idle', 'idle'],
    ['session-error', 'error'],
    ['session-complete', 'done'],
  ];

  it.each(cases)('%s -> %s', (name, expected) => {
    expect(translateOpenCodeHook(fixture(name))?.status).toBe(expected);
  });

  it('every fixture is a valid OpenCodeHookPayload (shared schema is the source of truth)', () => {
    for (const [name] of cases) {
      expect(OpenCodeHookPayload.safeParse(fixture(name)).success).toBe(true);
    }
  });
});

describe('translateOpenCodeHook — the money state (awaiting_input, FR-ST4)', () => {
  it('permission.updated -> awaiting_input (current OpenCode event) with the prompt title', () => {
    const t = translateOpenCodeHook(fixture('permission-updated'));
    expect(t).toEqual({ status: 'awaiting_input', detail: 'Run shell command' });
  });

  it('permission.request (legacy name, tolerated) -> awaiting_input with the prompt title', () => {
    const t = translateOpenCodeHook(fixture('permission-request'));
    expect(t).toEqual({ status: 'awaiting_input', detail: 'Run shell command' });
  });

  it('question.ask -> awaiting_input with a descriptive detail', () => {
    const t = translateOpenCodeHook(fixture('question-ask'));
    expect(t).toEqual({ status: 'awaiting_input', detail: 'question.ask' });
  });
});

describe('translateOpenCodeHook — tool execution', () => {
  it('tool.execute.after with success:false -> error', () => {
    expect(
      translateOpenCodeHook({ type: 'tool.execute.after', properties: { success: false } })?.status,
    ).toBe('error');
  });

  it('tool.execute.after with a nonzero exit code -> error', () => {
    expect(
      translateOpenCodeHook({ type: 'tool.execute.after', properties: { exit: 2 } })?.status,
    ).toBe('error');
  });

  it('tool.execute.after with exit 0 -> running', () => {
    expect(
      translateOpenCodeHook({ type: 'tool.execute.after', properties: { exit: 0 } })?.status,
    ).toBe('running');
  });

  it('carries the tool name through as detail when present', () => {
    expect(
      translateOpenCodeHook({ type: 'tool.execute.before', properties: { tool: 'bash' } })?.detail,
    ).toBe('bash');
  });
});

describe('translateOpenCodeHook — telemetry (message.updated / session.updated)', () => {
  it('extracts model + tokens + context + agent-reported cost, with no status change', () => {
    const t = translateOpenCodeHook(fixture('message-updated'));
    expect(t?.status).toBeNull(); // telemetry-only frame
    expect(t?.telemetry).toEqual({
      model: 'deepseek-v4-flash-free',
      // input + output + reasoning + cache.read + cache.write
      tokens: 23520 + 129 + 0 + 20864 + 0,
      // input + cache.read + cache.write (prompt the model saw)
      contextTokens: 23520 + 20864 + 0,
      costUsd: 0.0123,
    });
  });

  it('message-updated is a valid OpenCodeHookPayload (shared schema)', () => {
    expect(OpenCodeHookPayload.safeParse(fixture('message-updated')).success).toBe(true);
  });

  it('reads model id from a Session-shaped info.model.id (session.updated)', () => {
    const t = translateOpenCodeHook({
      type: 'session.updated',
      properties: { info: { model: { id: 'gpt-5' }, cost: 0.5, tokens: { input: 100 } } },
    });
    expect(t?.status).toBeNull();
    expect(t?.telemetry).toMatchObject({ model: 'gpt-5', costUsd: 0.5, contextTokens: 100 });
  });

  it('returns null when a telemetry event carries no usable info', () => {
    expect(translateOpenCodeHook({ type: 'message.updated', properties: {} })).toBeNull();
    expect(translateOpenCodeHook({ type: 'session.updated', properties: { info: {} } })).toBeNull();
  });
});

describe('translateOpenCodeHook — no transition (purity + robustness)', () => {
  it('returns null for an unrecognized event type', () => {
    expect(translateOpenCodeHook({ type: 'todo.updated' })).toBeNull();
    expect(translateOpenCodeHook({ type: 'file.edited' })).toBeNull();
  });

  it('returns null for a malformed / non-OpenCode payload', () => {
    expect(translateOpenCodeHook({ hook_event_name: 'Stop' })).toBeNull();
    expect(translateOpenCodeHook({ event: 'Stop' })).toBeNull();
    expect(translateOpenCodeHook(null)).toBeNull();
    expect(translateOpenCodeHook('not-an-object')).toBeNull();
    expect(translateOpenCodeHook(42)).toBeNull();
  });

  it('never produces disconnected (orchestrator-derived, spec §7.1)', () => {
    for (const [name] of [
      ['session-start'],
      ['session-idle'],
      ['session-error'],
      ['session-complete'],
      ['permission-request'],
      ['question-ask'],
    ] as const) {
      expect(translateOpenCodeHook(fixture(name))?.status).not.toBe('disconnected');
    }
  });
});

describe('OPENCODE_AGENT_TYPE', () => {
  it('matches the agent_type the dispatcher switches on', () => {
    expect(OPENCODE_AGENT_TYPE).toBe('opencode');
  });
});
