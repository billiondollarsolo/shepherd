import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { singleSessionLayout, type ProjectPensV1 } from '@flock/shared';
import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { nodes, projects } from '../db/schema.js';
import { ensureIntegrationOwner } from '../../test/integration-owner.js';
import { ProjectPensConflictError, ProjectPensService } from './project-pens-service.js';

let handle: DbHandle;
let ownerId: string;
let projectId: string;
let service: ProjectPensService;

function document(sessionId: string): ProjectPensV1 {
  return {
    version: 1,
    projectId,
    activePenId: 'pen-1',
    pens: [
      {
        id: 'pen-1',
        name: 'Pen 1',
        layout: singleSessionLayout(projectId, sessionId),
      },
    ],
    independentSessionIds: [],
  };
}

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  ownerId = (await ensureIntegrationOwner(handle.db, `pens-${randomUUID()}`)).id;
  let [node] = await handle.db.select({ id: nodes.id }).from(nodes).limit(1);
  if (!node) {
    [node] = await handle.db
      .insert(nodes)
      .values({ name: `pens-node-${randomUUID()}`, kind: 'local', createdBy: ownerId })
      .returning({ id: nodes.id });
  }
  const [project] = await handle.db
    .insert(projects)
    .values({ nodeId: node!.id, name: `pens-${randomUUID()}`, workingDir: '/tmp/flock-pens' })
    .returning({ id: projects.id });
  projectId = project!.id;
  service = new ProjectPensService(handle.db);
});

afterAll(async () => {
  await handle.db.delete(projects).where(eq(projects.id, projectId));
  await handle.pool.end();
});

describe('durable project Pens', () => {
  it('returns revision zero before the first save', async () => {
    await expect(service.get(ownerId, projectId)).resolves.toEqual({ pens: null, revision: 0 });
  });

  it('persists layouts with optimistic revisions', async () => {
    const first = await service.put(ownerId, projectId, 0, document(randomUUID()));
    expect(first.revision).toBe(1);
    await expect(service.get(ownerId, projectId)).resolves.toEqual(first);

    const second = await service.put(ownerId, projectId, first.revision, document(randomUUID()));
    expect(second.revision).toBe(2);
  });

  it('rejects stale writers and returns the current layout', async () => {
    const current = await service.get(ownerId, projectId);
    await expect(
      service.put(ownerId, projectId, current.revision - 1, document(randomUUID())),
    ).rejects.toMatchObject({
      name: ProjectPensConflictError.name,
      current: { revision: current.revision },
    });
  });
});
