import { describe, expect, it } from 'vitest';
import { AuditEntry, AuditLogger, AuditSink, nullAuditSink } from './audit.js';

class FakeSink implements AuditSink {
  rows: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.rows.push(entry);
  }
}

describe('AuditLogger (FR-A3 — minimal append-only audit util)', () => {
  it('normalizes optional fields to null for a consistent row shape', async () => {
    const sink = new FakeSink();
    await new AuditLogger(sink).record({ action: 'login' });

    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toEqual({
      userId: null,
      action: 'login',
      targetType: null,
      targetId: null,
      ip: null,
      detail: null,
    });
  });

  it('passes through provided fields', async () => {
    const sink = new FakeSink();
    await new AuditLogger(sink).record({
      action: 'node_add',
      userId: 'u1',
      targetType: 'node',
      targetId: 'n1',
      ip: '1.2.3.4',
      detail: { name: 'build-box' },
    });
    expect(sink.rows[0]).toMatchObject({
      action: 'node_add',
      userId: 'u1',
      targetType: 'node',
      targetId: 'n1',
      ip: '1.2.3.4',
      detail: { name: 'build-box' },
    });
  });

  it('recordSecretAccess writes a secret_access row targeting the secret', async () => {
    const sink = new FakeSink();
    await new AuditLogger(sink).recordSecretAccess({
      secretId: 'sec-1',
      userId: 'u2',
      ip: '9.9.9.9',
      keyVersion: 2,
    });
    expect(sink.rows[0]).toMatchObject({
      action: 'secret_access',
      targetType: 'secret',
      targetId: 'sec-1',
      userId: 'u2',
      ip: '9.9.9.9',
      detail: { keyVersion: 2 },
    });
  });

  it('recordNodeAdd writes a node_add row targeting the node (US-40, FR-A3)', async () => {
    const sink = new FakeSink();
    await new AuditLogger(sink).recordNodeAdd({
      nodeId: 'node-1',
      userId: 'u1',
      ip: '1.2.3.4',
      detail: { name: 'build-box', kind: 'ssh' },
    });
    expect(sink.rows[0]).toMatchObject({
      action: 'node_add',
      targetType: 'node',
      targetId: 'node-1',
      userId: 'u1',
      ip: '1.2.3.4',
      detail: { name: 'build-box', kind: 'ssh' },
    });
  });

  it('recordNodeRemove writes a node_remove row targeting the node (US-40, FR-A3)', async () => {
    const sink = new FakeSink();
    await new AuditLogger(sink).recordNodeRemove({ nodeId: 'node-9', userId: 'u2' });
    expect(sink.rows[0]).toMatchObject({
      action: 'node_remove',
      targetType: 'node',
      targetId: 'node-9',
      userId: 'u2',
    });
  });

  it('recordSessionCreate writes a session_create row targeting the session (US-40, FR-A3)', async () => {
    const sink = new FakeSink();
    await new AuditLogger(sink).recordSessionCreate({
      sessionId: 'sess-1',
      userId: 'u3',
      detail: { agentType: 'claude-code' },
    });
    expect(sink.rows[0]).toMatchObject({
      action: 'session_create',
      targetType: 'session',
      targetId: 'sess-1',
      userId: 'u3',
      detail: { agentType: 'claude-code' },
    });
  });

  it('nullAuditSink swallows writes without error', async () => {
    await expect(
      new AuditLogger(nullAuditSink).record({ action: 'logout' }),
    ).resolves.toBeUndefined();
  });
});
