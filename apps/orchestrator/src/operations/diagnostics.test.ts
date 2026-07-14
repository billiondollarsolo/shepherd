import { describe, expect, it } from 'vitest';
import { FlockDiagnosticsSchema } from '@flock/shared';
import { DiagnosticSink } from '../runtime/diagnostics';
import { collectDiagnostics } from './diagnostics';

describe('collectDiagnostics', () => {
  it('separates dependency health and returns a schema-valid redacted bundle', async () => {
    const pool = {
      query: async (query: unknown) =>
        String(query).includes('__drizzle_migrations')
          ? { rows: [{ count: '21' }] }
          : { rows: [{ '?column?': 1 }] },
    } as never;
    const sink = new DiagnosticSink(10, undefined, () => ['canary-secret']);
    sink.record({ category: 'test', operation: 'failure', message: 'lost canary-secret' });
    const result = FlockDiagnosticsSchema.parse(
      await collectDiagnostics({
        pool,
        sink,
        agentdHealth: async () => ({ enabled: true, nodes: {}, sessions: {} }),
        listNodes: async () => [{ id: 'node' }],
        previewHealth: () => ({ enabled: true, active: 1, reason: null }),
        collectionSizes: () => ({ liveSessions: 1 }),
        env: { NODE_ENV: 'production', FLOCK_AGENTD_VERSION: '0.3.0' },
      }),
    );
    expect(result.health.database.status).toBe('ready');
    expect(result.health.migrations.count).toBe(21);
    expect(result.health.nodes.count).toBe(1);
    expect(result.health.preview).toEqual({ status: 'available', active: 1, reason: null });
    expect(JSON.stringify(result)).not.toContain('canary-secret');
  });
});
