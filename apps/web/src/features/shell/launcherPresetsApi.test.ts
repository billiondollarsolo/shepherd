import { describe, expect, it, vi } from 'vitest';
import { fetchLauncherPresets, putLauncherPresets } from './launcherPresetsApi';

describe('launcherPresetsApi', () => {
  it('fetchLauncherPresets returns presets array', async () => {
    const fetchImpl = vi.fn(async () =>
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

  it('putLauncherPresets sends user presets', async () => {
    const mine = [{ id: 'mine', name: 'Mine', agentType: 'codex' as const }];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      return new Response(JSON.stringify({ presets: mine }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await putLauncherPresets(mine, fetchImpl);
    expect(got.some((p) => p.id === 'mine')).toBe(true);
  });
});
