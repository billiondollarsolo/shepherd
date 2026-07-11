import { describe, expect, it, vi } from 'vitest';
import { fetchLauncherPresets } from './launcherPresetsApi';

describe('launcherPresetsApi', () => {
  it('fetchLauncherPresets returns presets array', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            presets: [{ id: 'builtin-claude', name: 'Claude Code', agentType: 'claude-code' }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const presets = await fetchLauncherPresets(fetchImpl);
    expect(presets[0]?.agentType).toBe('claude-code');
  });

  it('falls back to built-in presets when the endpoint is unavailable', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 503 }),
    ) as unknown as typeof fetch;
    const got = await fetchLauncherPresets(fetchImpl);
    expect(got.map((preset) => preset.id)).toEqual([
      'builtin-claude',
      'builtin-codex',
      'builtin-opencode',
      'builtin-gemini',
      'builtin-grok',
      'builtin-terminal',
    ]);
  });
});
