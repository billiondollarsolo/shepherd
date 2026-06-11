/**
 * Gemini CLI translator contract test (spec §7.1). Gemini CLI v0.26.0+ hooks are
 * doc-based until validated on a live authed gemini, so these use inline payloads
 * (not recorded fixtures) covering each documented event → status mapping, incl.
 * tolerance of both `hook_event_name` and camelCase `hookEventName`.
 */
import { describe, expect, it } from 'vitest';

import { translateGeminiHook, GEMINI_AGENT_TYPE } from './gemini.js';

describe('Gemini CLI translator (spec §7.1)', () => {
  it('exposes the gemini agent type tag', () => {
    expect(GEMINI_AGENT_TYPE).toBe('gemini');
  });

  const cases: ReadonlyArray<[string, unknown, string | null]> = [
    ['SessionStart -> idle (ready)', { hook_event_name: 'SessionStart' }, 'idle'],
    ['BeforeAgent -> running', { hook_event_name: 'BeforeAgent' }, 'running'],
    ['BeforeTool -> running', { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' }, 'running'],
    ['AfterTool -> running', { hook_event_name: 'AfterTool', tool_name: 'run_shell_command' }, 'running'],
    ['Notification -> awaiting_input', { hook_event_name: 'Notification', message: 'allow?' }, 'awaiting_input'],
    ['AfterAgent -> idle (turn complete)', { hook_event_name: 'AfterAgent' }, 'idle'],
    ['SessionEnd -> done', { hook_event_name: 'SessionEnd' }, 'done'],
    // camelCase field tolerated:
    ['hookEventName camelCase tolerated', { hookEventName: 'SessionStart' }, 'idle'],
    // no-transition events:
    ['PreCompress -> null', { hook_event_name: 'PreCompress' }, null],
  ];

  for (const [name, payload, expected] of cases) {
    it(`maps ${name}`, () => {
      const t = translateGeminiHook(payload);
      if (expected === null) {
        // PreCompress is a recognized-but-no-transition event.
        expect(t === null || t.status === null).toBe(true);
      } else {
        expect(t?.status).toBe(expected);
      }
    });
  }

  it('returns null for a non-gemini / malformed payload', () => {
    expect(translateGeminiHook(null)).toBeNull();
    expect(translateGeminiHook({ type: 'session.idle' })).toBeNull();
    expect(translateGeminiHook({ hook_event_name: 'NotARealEvent' })).toBeNull();
  });

  it('carries the tool name as detail on BeforeTool', () => {
    expect(translateGeminiHook({ hook_event_name: 'BeforeTool', tool_name: 'write_file' })).toEqual({
      status: 'running',
      detail: 'write_file',
    });
  });
});
