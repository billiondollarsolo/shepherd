import { randomBytes, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { agentCapabilities, agentSessions, nodes, projects, users } from '../db/schema.js';
import { hashHookToken } from '../hooks/hook-token.js';
import { AgentCapabilityService } from './capability-service.js';
import { DEFAULT_PROJECT_AGENT_POLICY } from '@flock/shared';

let handle: DbHandle;
let userId: string;
let projectId: string;
let nodeId: string;

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  const [user] = await handle.db
    .insert(users)
    .values({
      username: `cap-user-${randomUUID()}`,
      passwordHash: 'argon2id$fixture',
      role: 'admin',
    })
    .returning();
  userId = user!.id;
  const [node] = await handle.db
    .insert(nodes)
    .values({ name: `cap-node-${randomUUID()}`, kind: 'local', connectionStatus: 'connected' })
    .returning();
  const [project] = await handle.db
    .insert(projects)
    .values({ nodeId: node!.id, name: 'cap-project', workingDir: '/tmp/cap-project' })
    .returning();
  projectId = project!.id;
  nodeId = node!.id;
});

afterAll(async () => {
  await handle?.pool.end();
});

async function createSession(): Promise<{ id: string; hookToken: string }> {
  const id = randomUUID();
  const hookToken = randomBytes(32).toString('base64url');
  await handle.db.insert(agentSessions).values({
    id,
    nodeId,
    projectId,
    agentType: 'codex',
    tmuxSessionName: `flock-${id}`,
    workingDir: '/tmp/cap-project',
    hookTokenHash: hashHookToken(hookToken),
    status: 'running',
    createdBy: userId,
  });
  return { id, hookToken };
}

describe('scoped agent orchestration capabilities', () => {
  it('issues nothing by default and never accepts the callback token', async () => {
    const session = await createSession();
    const service = new AgentCapabilityService({
      db: handle.db,
      installationId: 'installation-a',
    });
    await expect(service.issue(session.id, projectId, [])).resolves.toBeUndefined();
    await expect(
      service.authorize(session.id, session.hookToken, 'agents:list:project'),
    ).rejects.toThrow(/capability/);
    const rows = await handle.db
      .select()
      .from(agentCapabilities)
      .where(eq(agentCapabilities.sessionId, session.id));
    expect(rows).toHaveLength(0);
  });

  it('enforces verb, session, installation, expiry, and revocation bindings', async () => {
    let now = new Date('2026-07-11T20:00:00.000Z');
    const session = await createSession();
    const other = await createSession();
    const service = new AgentCapabilityService({
      db: handle.db,
      installationId: 'installation-a',
      now: () => now,
      ttlMs: 60_000,
    });
    const token = await service.issue(session.id, projectId, [
      'agents:list:project',
      'agents:read:project',
    ]);
    expect(token).toBeTruthy();
    await expect(
      service.authorize(session.id, token!, 'agents:list:project'),
    ).resolves.toMatchObject({ sessionId: session.id, projectId });
    await expect(service.authorize(session.id, token!, 'agents:send:project')).rejects.toThrow();
    await expect(service.authorize(other.id, token!, 'agents:list:project')).rejects.toThrow();
    const otherInstall = new AgentCapabilityService({
      db: handle.db,
      installationId: 'installation-b',
      now: () => now,
    });
    await expect(
      otherInstall.authorize(session.id, token!, 'agents:list:project'),
    ).rejects.toThrow();

    now = new Date('2026-07-11T20:02:00.000Z');
    await expect(service.authorize(session.id, token!, 'agents:list:project')).rejects.toThrow();

    now = new Date('2026-07-11T20:00:00.000Z');
    await service.revokeSession(session.id);
    await expect(service.authorize(session.id, token!, 'agents:list:project')).rejects.toThrow();
  });

  it('immediately enforces a narrowed durable project policy against existing tokens', async () => {
    const session = await createSession();
    const service = new AgentCapabilityService({
      db: handle.db,
      installationId: 'installation-policy-test',
    });
    const token = await service.issue(session.id, projectId, [
      'agents:list:project',
      'agents:terminate:project',
    ]);
    await expect(
      service.authorize(session.id, token!, 'agents:terminate:project'),
    ).resolves.toBeTruthy();

    await handle.db
      .update(projects)
      .set({
        agentPolicy: {
          ...DEFAULT_PROJECT_AGENT_POLICY,
          maxAuthority: 'observe',
        },
      })
      .where(eq(projects.id, projectId));

    await expect(service.authorize(session.id, token!, 'agents:terminate:project')).rejects.toThrow(
      /disabled by current project policy/,
    );
    await expect(
      service.authorize(session.id, token!, 'agents:list:project'),
    ).resolves.toBeTruthy();

    await handle.db
      .update(projects)
      .set({ agentPolicy: DEFAULT_PROJECT_AGENT_POLICY })
      .where(eq(projects.id, projectId));
  });
});
