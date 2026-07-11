import { describe, expect, it } from 'vitest';
import { DiagnosticSink } from './diagnostics';

describe('DiagnosticSink', () => {
  it('bounds events and redacts key names, URLs, bearer tokens, and known canaries', () => {
    const sink = new DiagnosticSink(
      2,
      () => new Date('2026-01-01T00:00:00Z'),
      () => ['canary-1234'],
    );
    sink.record({ category: 'db', operation: 'one', message: 'old' });
    sink.record({
      category: 'ssh',
      operation: 'connect',
      message: 'Bearer abc.def canary-1234 postgres://me:hunter2@db/flock',
      context: { token: 'visible', nodeId: 'node-1' },
    });
    sink.record({ category: 'browser', operation: 'stop', message: new Error('failed') });
    const serialized = JSON.stringify(sink.snapshot());
    expect(sink.snapshot().events).toHaveLength(2);
    expect(serialized).not.toContain('abc.def');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('canary-1234');
    expect(serialized).not.toContain('visible');
    expect(sink.snapshot().counters['browser.stop.error']).toBe(1);
  });

  it('bounds low-cardinality counters under hostile unique names', () => {
    const sink = new DiagnosticSink(2, undefined, undefined, 10);
    for (let index = 0; index < 1_000; index++) sink.increment(`unique-${index}`);
    expect(Object.keys(sink.snapshot().counters)).toHaveLength(10);
  });
});
