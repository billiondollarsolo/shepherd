import { describe, expect, it } from 'vitest';
import { FlockDiagnosticsSchema } from './diagnostics';

describe('FlockDiagnosticsSchema', () => {
  it('rejects token-shaped undeclared fields', () => {
    expect(() =>
      FlockDiagnosticsSchema.parse({
        bundleVersion: 1,
        generatedAt: new Date(0).toISOString(),
        token: 'must not be accepted',
      }),
    ).toThrow();
  });
});
