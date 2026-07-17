import { describe, expect, it } from 'vitest';
import { isChatCapable } from './chatCapable';

describe('isChatCapable', () => {
  it('is true for agents with a structured transcript', () => {
    for (const a of ['claude-code', 'codex', 'opencode', 'gemini']) {
      expect(isChatCapable(a)).toBe(true);
    }
  });

  it('is false for terminal-only agents and unknown/empty input', () => {
    for (const a of [
      'grok',
      'aider',
      'cursor-agent',
      'amp',
      'terminal',
      'dev',
      'nope',
      '',
      null,
      undefined,
    ]) {
      expect(isChatCapable(a)).toBe(false);
    }
  });
});
