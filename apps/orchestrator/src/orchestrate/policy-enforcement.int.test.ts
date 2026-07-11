import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT_AGENT_POLICY, type ProjectAgentPolicy } from '@flock/shared';

import { createDb, type DbHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { agentSessions, nodes, projects, users } from '../db/schema.js';
import { StatusMap } from '../status/map.js';
import { OrchestrationService } from './orchestrate-service.js';

let handle: DbHandle;
let userId: string;
let nodeId: string;
let projectId: string;
let callerId: string;
let targetId: string;

beforeAll(async () => {
  handle = createDb();
  await runMigrations(handle);
  const [user] = await handle.db
    .insert(users)
    .values({
      username: `policy-${randomUUID()}`,
      passwordHash: 'argon2id$fixture',
      role: 'admin',
    })
    .returning();
  userId = user!.id;
  const [node] = await handle.db
    .insert(nodes)
    .values({ name: `policy-${randomUUID()}`, kind: 'local', connectionStatus: 'connected' })
    .returning();
  nodeId = node!.id;
  const [project] = await handle.db
    .insert(projects)
    .values({ nodeId, name: 'policy', workingDir: '/tmp/policy' })
    .returning();
  projectId = project!.id;
  callerId = await insertSession('codex');
  targetId = await insertSession('claude-code');
});

afterAll(async () => {
  await handle?.pool.end();
});

async function insertSession(agentType: 'codex' | 'claude-code'): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(agentSessions).values({
    id,
    nodeId,
    projectId,
    agentType,
    tmuxSessionName: `flock-${id}`,
    workingDir: '/tmp/policy',
    hookTokenHash: `hash-${id}`,
    status: 'running',
    createdBy: userId,
  });
  return id;
}

function service(
  policy: ProjectAgentPolicy,
  hooks: { sent?: string[]; readLimits?: number[]; spawns?: string[]; denied?: string[] } = {},
): OrchestrationService {
  return new OrchestrationService(
    handle.db,
    new StatusMap(),
    async (_caller, _token, required) => ({
      projectId,
      createdBy: userId,
      scopes: [
        'agents:list:project',
        'agents:read:project',
        'agents:send:project',
        'agents:spawn:project',
        'agents:terminate:project',
      ],
      policy,
    }),
    async () => ({}),
    async () => {
      hooks.spawns?.push('spawn');
      return randomUUID();
    },
    async (_target, text) => {
      hooks.sent?.push(text);
      return true;
    },
    async () => true,
    async (_target, limit) => {
      hooks.readLimits?.push(limit);
      return [];
    },
    60_000,
    () => 1_000,
    (_caller, scope) => hooks.denied?.push(scope),
  );
}

describe('server-owned orchestration policy enforcement', () => {
  it('enforces send-byte and read-message limits even when the client bypasses the UI', async () => {
    const hooks = { sent: [] as string[], readLimits: [] as number[] };
    const svc = service(
      { ...DEFAULT_PROJECT_AGENT_POLICY, maxSendBytes: 256, maxReadMessages: 7 },
      hooks,
    );
    await expect(svc.send(callerId, 'token', targetId, 'x'.repeat(257))).rejects.toThrow(
      /project limit/,
    );
    expect(hooks.sent).toEqual([]);
    await svc.readOutput(callerId, 'token', targetId, 999);
    expect(hooks.readLimits).toEqual([7]);
  });

  it('enforces project concurrency and spawn-rate limits', async () => {
    const capHooks = { spawns: [] as string[] };
    const capped = service({ ...DEFAULT_PROJECT_AGENT_POLICY, maxConcurrentAgents: 1 }, capHooks);
    await expect(capped.spawn(callerId, 'token', 'codex')).rejects.toThrow(/spawn cap/);
    expect(capHooks.spawns).toEqual([]);

    const rateHooks = { spawns: [] as string[] };
    const rateLimited = service(
      {
        ...DEFAULT_PROJECT_AGENT_POLICY,
        maxConcurrentAgents: 64,
        spawnRateLimitPerMinute: 1,
      },
      rateHooks,
    );
    await expect(rateLimited.spawn(callerId, 'token', 'codex')).resolves.toBeTruthy();
    await expect(rateLimited.spawn(callerId, 'token', 'codex')).rejects.toThrow(/rate limit/);
    expect(rateHooks.spawns).toHaveLength(1);
  });
});
