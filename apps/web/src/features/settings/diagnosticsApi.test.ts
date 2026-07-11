import { describe, expect, it, vi } from 'vitest';
import { fetchDiagnostics } from './diagnosticsApi';

describe('fetchDiagnostics', () => {
  it('runtime-validates the owner diagnostics response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ bundleVersion: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    await expect(fetchDiagnostics(fetchImpl)).rejects.toThrow();
  });
});
