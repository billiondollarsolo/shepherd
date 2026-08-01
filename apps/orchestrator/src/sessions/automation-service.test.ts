import { describe, expect, it } from 'vitest';

import type { AutomationScope } from './automation-authz.js';
import {
  AUTOMATION_WAIT_DEFAULT_MS,
  AUTOMATION_WAIT_MAX_MS,
  AutomationAuthzError,
  AutomationBadRequestError,
  assertProjectAutomation,
  buildExplainResponse,
  buildKeysRequest,
  buildPromptRequest,
  normalizeWaitTimeoutMs,
} from './automation-service.js';

const scope: AutomationScope = { projectId: 'p1', sessionId: 's1' };

describe('assertProjectAutomation', () => {
  it('allows same-project prompt and does not throw', () => {
    expect(() => assertProjectAutomation(scope, 'prompt', 'p1')).not.toThrow();
  });

  it('throws AutomationAuthzError on cross-project', () => {
    expect(() => assertProjectAutomation(scope, 'prompt', 'p2')).toThrow(AutomationAuthzError);
    try {
      assertProjectAutomation(scope, 'wait', 'other');
    } catch (e) {
      expect(e).toBeInstanceOf(AutomationAuthzError);
      expect((e as AutomationAuthzError).code).toBe('automation_denied');
    }
  });

  it('throws on admin action', () => {
    expect(() => assertProjectAutomation(scope, 'admin', 'p1')).toThrow(AutomationAuthzError);
  });
});

describe('buildPromptRequest', () => {
  it('returns session.prompt payload', () => {
    expect(buildPromptRequest('hello')).toEqual({ text: 'hello', op: 'session.prompt' });
  });

  it('rejects empty or non-string text', () => {
    expect(() => buildPromptRequest('')).toThrow(AutomationBadRequestError);
    expect(() => buildPromptRequest(null as unknown as string)).toThrow(AutomationBadRequestError);
  });
});

describe('buildKeysRequest', () => {
  it('returns session.send_keys payload', () => {
    expect(buildKeysRequest(['esc', 'ctrl+c'])).toEqual({
      keys: ['esc', 'ctrl+c'],
      op: 'session.send_keys',
    });
  });

  it('rejects empty or invalid keys', () => {
    expect(() => buildKeysRequest([])).toThrow(AutomationBadRequestError);
    expect(() => buildKeysRequest([''])).toThrow(AutomationBadRequestError);
  });
});

describe('buildExplainResponse', () => {
  it('includes required agent and state', () => {
    expect(buildExplainResponse('codex', 'idle')).toEqual({ agent: 'codex', state: 'idle' });
  });

  it('includes optional matchedRuleId and source when provided', () => {
    expect(buildExplainResponse('claude-code', 'awaiting_input', 'rule-approve', 'screen')).toEqual(
      {
        agent: 'claude-code',
        state: 'awaiting_input',
        matchedRuleId: 'rule-approve',
        source: 'screen',
      },
    );
  });

  it('omits empty optional fields', () => {
    expect(buildExplainResponse('codex', 'running', '', '')).toEqual({
      agent: 'codex',
      state: 'running',
    });
  });
});

describe('normalizeWaitTimeoutMs', () => {
  it('defaults and caps timeout', () => {
    expect(normalizeWaitTimeoutMs()).toBe(AUTOMATION_WAIT_DEFAULT_MS);
    expect(normalizeWaitTimeoutMs(undefined)).toBe(AUTOMATION_WAIT_DEFAULT_MS);
    expect(normalizeWaitTimeoutMs(5_000)).toBe(5_000);
    expect(normalizeWaitTimeoutMs(AUTOMATION_WAIT_MAX_MS + 1)).toBe(AUTOMATION_WAIT_MAX_MS);
  });

  it('rejects negative or non-finite values', () => {
    expect(() => normalizeWaitTimeoutMs(-1)).toThrow(AutomationBadRequestError);
    expect(() => normalizeWaitTimeoutMs(Number.NaN)).toThrow(AutomationBadRequestError);
  });
});
