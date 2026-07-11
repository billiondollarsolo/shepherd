import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { userPreferences } from '../db/schema.js';
import { ensureIntegrationOwner } from '../../test/integration-owner.js';
import {
  UserPreferencesConflictError,
  UserPreferencesService,
} from './user-preferences-service.js';
import type { UserPreferencesDocument, UserPreferencesValueV1 } from '@flock/shared';

let handle: DbHandle;
let ownerId: string;
let service: UserPreferencesService;

function valueOf(document: UserPreferencesDocument): UserPreferencesValueV1 {
  const { revision: _revision, updatedAt: _updatedAt, ...value } = document;
  return value;
}

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  ownerId = (await ensureIntegrationOwner(handle.db, `prefs-${randomUUID()}`)).id;
  await handle.db.delete(userPreferences).where(eq(userPreferences.userId, ownerId));
  service = new UserPreferencesService(handle.db);
});

afterAll(async () => {
  await handle.db.delete(userPreferences).where(eq(userPreferences.userId, ownerId));
  await handle.pool.end();
});

describe('durable user preferences', () => {
  it('starts with a versioned revision-zero document', async () => {
    await expect(service.get(ownerId)).resolves.toMatchObject({
      version: 1,
      revision: 0,
      nodeOrder: [],
      sessionOrder: {},
      layoutPresets: [],
      updatedAt: null,
    });
  });

  it('persists ordering and saved layouts with optimistic revisions', async () => {
    const nodeId = randomUUID();
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const first = await service.put(ownerId, 0, {
      version: 1,
      nodeOrder: [nodeId],
      sessionOrder: { [projectId]: [sessionId] },
      layoutPresets: [
        {
          id: randomUUID(),
          name: 'Daily work',
          projectId,
          gridLayout: 'grid',
          order: [sessionId],
        },
      ],
    });
    expect(first.revision).toBe(1);
    await expect(service.get(ownerId)).resolves.toEqual(first);

    const second = await service.put(ownerId, first.revision, {
      ...valueOf(first),
      nodeOrder: [],
    });
    expect(second.revision).toBe(2);
    expect(second.nodeOrder).toEqual([]);
  });

  it('rejects a stale writer with the current document', async () => {
    const current = await service.get(ownerId);
    await expect(
      service.put(ownerId, current.revision - 1, {
        ...valueOf(current),
        nodeOrder: [randomUUID()],
      }),
    ).rejects.toMatchObject({
      name: UserPreferencesConflictError.name,
      current: { revision: current.revision },
    });
  });
});
