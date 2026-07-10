/**
 * Grok translator contract test. Pins the Grok hook event → {@link Status}
 * mapping against payloads in Grok's real shape (camelCase fields, snake_case
 * event-name values), the same shape Grok POSTs to `POST /api/hooks/:sessionId`.
 */
import { describe, expect, it } from 'vitest';

import { GROK_AGENT_TYPE, translateGrokHook } from './grok.js';

describe('translateGrokHook (Grok lifecycle hooks)', () => {
  it('session_start -> idle (ready for you)', () => {
    expect(translateGrokHook({ hookEventName: 'session_start' })).toEqual({
      status: 'idle',
      detail: null,
    });
  });

  it('pre_tool_use -> running, carrying the tool name as detail', () => {
    expect(
      translateGrokHook({ hookEventName: 'pre_tool_use', toolName: 'run_terminal_command' }),
    ).toEqual({ status: 'running', detail: 'run_terminal_command' });
  });

  it('post_tool_use (success) -> running', () => {
    expect(
      translateGrokHook({ hookEventName: 'post_tool_use', toolName: 'edit_file' }),
    ).toEqual({ status: 'running', detail: 'edit_file' });
  });

  it('post_tool_use (failure) -> error', () => {
    expect(
      translateGrokHook({ hookEventName: 'post_tool_use', toolName: 'run_terminal_command', exitCode: 2 })
        ?.status,
    ).toBe('error');
    expect(
      translateGrokHook({ hookEventName: 'post_tool_use', success: false })?.status,
    ).toBe('error');
  });

  it('post_tool_use_failure -> error', () => {
    expect(
      translateGrokHook({ hookEventName: 'post_tool_use_failure', toolName: 'run_terminal_command' }),
    ).toEqual({ status: 'error', detail: 'run_terminal_command' });
  });

  it('stop -> idle (turn complete; done reserved for session end)', () => {
    expect(translateGrokHook({ hookEventName: 'stop' })).toEqual({ status: 'idle', detail: null });
  });

  it('notification (xai_session meta) -> recognized but no transition (status null)', () => {
    // status:null means the endpoint drops it from the timeline + event log
    // (Grok emits one of these per hook it runs — pure churn).
    expect(
      translateGrokHook({ hookEventName: 'notification', notificationType: 'xai_session' }),
    ).toEqual({ status: null, detail: null });
  });

  it('returns null for an unrecognized / malformed payload (logged for debugging)', () => {
    expect(translateGrokHook({ hookEventName: 'todo.updated' })).toBeNull();
    expect(translateGrokHook({ event: 'Stop' })).toBeNull(); // codex shape
    expect(translateGrokHook(null)).toBeNull();
    expect(translateGrokHook(42)).toBeNull();
  });

  it('never produces disconnected (orchestrator-derived)', () => {
    for (const ev of ['session_start', 'pre_tool_use', 'post_tool_use', 'stop'] as const) {
      expect(translateGrokHook({ hookEventName: ev })?.status).not.toBe('disconnected');
    }
  });
});

describe('GROK_AGENT_TYPE', () => {
  it('matches the agent_type the dispatcher switches on', () => {
    expect(GROK_AGENT_TYPE).toBe('grok');
  });
});
