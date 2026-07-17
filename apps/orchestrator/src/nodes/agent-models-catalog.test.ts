import { describe, expect, it } from 'vitest';

import {
  isNodeDiscoveredModels,
  parseAgyModels,
  parseCodexModelList,
  staticModelsFor,
} from './agent-models-catalog.js';

describe('agent-models-catalog', () => {
  it('parses `agy models` stdout into one --model value per non-empty line', () => {
    const stdout = 'Gemini 3.5 Flash (High)\nClaude Opus 4.6 (Thinking)\n\nGPT-OSS 120B (Medium)\n';
    expect(parseAgyModels(stdout)).toEqual([
      'Gemini 3.5 Flash (High)',
      'Claude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
    ]);
  });

  it('trims whitespace and drops comment/blank lines', () => {
    expect(parseAgyModels('  a  \n# header\n\n  b\n')).toEqual(['a', 'b']);
  });

  it('returns a curated static list for claude/codex and none for antigravity', () => {
    expect(staticModelsFor('claude-code')).toContain('opus');
    expect(staticModelsFor('codex').length).toBeGreaterThan(0);
    expect(staticModelsFor('antigravity')).toEqual([]);
    expect(staticModelsFor('terminal')).toEqual([]);
  });

  it('flags antigravity AND codex as node-discovered (dynamic model lists)', () => {
    expect(isNodeDiscoveredModels('antigravity')).toBe(true);
    expect(isNodeDiscoveredModels('codex')).toBe(true);
    expect(isNodeDiscoveredModels('claude-code')).toBe(false);
    expect(isNodeDiscoveredModels('terminal')).toBe(false);
  });

  describe('parseCodexModelList', () => {
    it('extracts model ids from the model/list JSON-RPC response line', () => {
      const stdout = [
        '{"id":1,"result":{"userAgent":"codex"}}',
        '{"method":"configWarning","params":{"message":"bubblewrap"}}',
        '{"id":2,"result":{"data":[' +
          '{"id":"gpt-5-codex","model":"gpt-5-codex","displayName":"GPT-5 Codex"},' +
          '{"id":"gpt-5","model":"gpt-5","displayName":"GPT-5"}' +
          '],"nextCursor":null}}',
      ].join('\n');
      expect(parseCodexModelList(stdout)).toEqual(['gpt-5-codex', 'gpt-5']);
    });

    it('falls back to `model` when `id` is absent and de-dupes, preserving order', () => {
      const stdout = '{"id":2,"result":{"data":[{"model":"a"},{"id":"b"},{"id":"a"},{"id":"b"}]}}';
      expect(parseCodexModelList(stdout)).toEqual(['a', 'b']);
    });

    it('returns [] for an unauthenticated codex (empty data) or noise-only output', () => {
      expect(parseCodexModelList('{"id":2,"result":{"data":[]}}')).toEqual([]);
      expect(parseCodexModelList('bwrap: creating sandbox failed\n\nnot json')).toEqual([]);
      expect(parseCodexModelList('')).toEqual([]);
    });
  });
});
