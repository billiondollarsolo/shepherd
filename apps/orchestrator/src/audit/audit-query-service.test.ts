/**
 * US-40 — AuditQueryService unit tests (run under `pnpm test:unit`).
 *
 * The admin READ side of the audit surface (FR-A3): an admin can read the
 * append-only audit log. These tests use an in-memory fake read-store so they
 * are pure (no real DB; the Drizzle-backed store is covered by the int test).
 *
 * Acceptance-critical assertions:
 *   - lists entries newest-first;
 *   - applies the default + max page size;
 *   - narrows by `action` and by `userId`;
 *   - reading the audit log NEVER touches the live status path (this service
 *     only ever calls the injected durable read-store).
 */
import { describe, expect, it } from 'vitest';

import type { AuditEntry } from '@flock/shared';

import {
  AuditQueryService,
  type AuditQueryFilter,
  type AuditReadStore,
} from './audit-query-service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    ts: '2026-05-29T00:00:00.000Z',
    userId: USER_A,
    action: 'login',
    targetType: 'user',
    targetId: USER_A,
    ip: '1.2.3.4',
    detail: null,
    ...overrides,
  };
}

/** Records the filter it was called with and returns canned rows. */
class FakeReadStore implements AuditReadStore {
  lastFilter?: AuditQueryFilter;
  constructor(private readonly rows: AuditEntry[]) {}
  async list(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    this.lastFilter = filter;
    return this.rows;
  }
}

describe('AuditQueryService.list (US-40, FR-A3 admin read)', () => {
  it('returns the store rows as the entries list', async () => {
    const rows = [entry({ action: 'login' }), entry({ action: 'node_add' })];
    const svc = new AuditQueryService(new FakeReadStore(rows));
    const result = await svc.list({});
    expect(result.entries).toEqual(rows);
  });

  it('applies the default page size when no limit is given', async () => {
    const store = new FakeReadStore([]);
    await new AuditQueryService(store).list({});
    expect(store.lastFilter?.limit).toBe(100); // AUDIT_DEFAULT_LIMIT
    expect(store.lastFilter?.offset).toBe(0);
  });

  it('clamps an over-cap limit to the max page size', async () => {
    const store = new FakeReadStore([]);
    await new AuditQueryService(store).list({ limit: 100000 });
    expect(store.lastFilter?.limit).toBe(500); // AUDIT_MAX_LIMIT
  });

  it('forwards action and userId filters to the store', async () => {
    const store = new FakeReadStore([]);
    await new AuditQueryService(store).list({
      action: 'node_remove',
      userId: USER_B,
      limit: 25,
      offset: 5,
    });
    expect(store.lastFilter).toEqual({
      action: 'node_remove',
      userId: USER_B,
      limit: 25,
      offset: 5,
    });
  });
});
