/**
 * SessionRestService unit tests (FR-S2/S3, §4.2 invariant) — `pnpm test:unit`.
 *
 * Uses an in-memory fake of the drizzle handle covering the exact select/insert
 * chains the service calls, so the create path (project→node resolution, hook
 * token mint, single authoritative record, best-effort agentd launch) is exercised
 * without real Postgres or a daemon.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_AGENT_POLICY,
  type CreateSessionRequest,
  type ProjectAgentPolicy,
} from '@flock/shared';

import { AuditLogger } from '../audit/audit.js';
import { nodes, projects } from '../db/schema.js';
import {
  SessionLaunchBlockedError,
  SessionProjectNotFoundError,
  SessionPolicyViolationError,
  SessionRestService,
  type AgentdLaunchOutcome,
  type SessionRestServiceDeps,
} from './session-rest-service.js';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const NODE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

class FakeDb {
  sessions: Record<string, unknown>[] = [];
  constructor(
    private readonly nodeRows: Record<string, unknown>[],
    private readonly projectRows: Record<string, unknown>[],
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(_table: unknown): any {
    return {
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const row = Object.assign({}, vals);
          this.sessions.push(row);
          return [row];
        },
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(_table: unknown): any {
    return {
      set: (vals: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const row = this.sessions[0];
            if (!row) return [];
            Object.assign(row, vals);
            return [row];
          },
        }),
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(_table: unknown): any {
    return {
      where: async () => {
        this.sessions = [];
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(_cols?: unknown): any {
    return {
      from: (table: unknown) => {
        const store =
          table === nodes ? this.nodeRows : table === projects ? this.projectRows : this.sessions;
        // bare `from(agentSessions)` (listSessions, no filter) → all rows;
        // `.where()` is either awaited (listSessions by project) → all rows,
        // or `.where().limit()` (project/node resolution) → first match.
        const whereThenable = Promise.resolve(store);
        return Object.assign(Promise.resolve(store), {
          where: () => Object.assign(whereThenable, { limit: async () => store.slice(0, 1) }),
        });
      },
    };
  }
}

function makeService(
  opts: {
    nodeKind?: 'local' | 'ssh';
    agentdLaunch?: SessionRestServiceDeps['agentdLaunch'];
    agentdLaunchPreflight?: SessionRestServiceDeps['agentdLaunchPreflight'];
    sessionEnv?: SessionRestServiceDeps['sessionEnv'];
    issueOrchestrationCapability?: SessionRestServiceDeps['issueOrchestrationCapability'];
    onSessionCreated?: SessionRestServiceDeps['onSessionCreated'];
    onSessionCreateAborted?: SessionRestServiceDeps['onSessionCreateAborted'];
    projectPolicy?: ProjectAgentPolicy;
  } = {},
) {
  const nodeRows = [
    { id: NODE_ID, kind: opts.nodeKind ?? 'local', name: 'local', connectionStatus: 'connected' },
  ];
  const projectRows = [
    {
      id: PROJECT_ID,
      nodeId: NODE_ID,
      name: 'flock',
      workingDir: '/work',
      agentPolicy: opts.projectPolicy ?? DEFAULT_PROJECT_AGENT_POLICY,
    },
  ];
  const db = new FakeDb(nodeRows, projectRows);
  const service = new SessionRestService({
    db: db as never,
    hashToken: async (t) => `hash:${t.slice(0, 6)}`,
    audit: new AuditLogger({ async write() {} }),
    agentdLaunch: opts.agentdLaunch,
    agentdLaunchPreflight: opts.agentdLaunchPreflight,
    sessionEnv: opts.sessionEnv,
    issueOrchestrationCapability: opts.issueOrchestrationCapability,
    onSessionCreated: opts.onSessionCreated,
    onSessionCreateAborted: opts.onSessionCreateAborted,
    logger: { warn() {} },
  });
  return { service, db };
}

const REQ: CreateSessionRequest = { projectId: PROJECT_ID, agentType: 'claude-code' };

describe('SessionRestService.createSession', () => {
  it('mints a hook token returned once, stores only its hash, threads one id (§4.2)', async () => {
    const { service, db } = makeService();
    const { session, hookToken } = await service.createSession(REQ, { userId: USER_ID });

    expect(hookToken).toBeTruthy();
    // Only the HASH is persisted; the plaintext token never appears in the record.
    expect(session.hookTokenHash).toMatch(/^hash:/);
    expect(session.hookTokenHash).not.toBe(hookToken);
    // One id threads the session name + record id.
    expect(session.tmuxSessionName).toContain(session.id);
    expect(session.nodeId).toBe(NODE_ID);
    expect(session.projectId).toBe(PROJECT_ID);
    expect(session.status).toBe('starting');
    expect(db.sessions).toHaveLength(1);
  });

  it('defaults workingDir to the project dir, honors an override', async () => {
    const a = await makeService().service.createSession(REQ, { userId: USER_ID });
    expect(a.session.workingDir).toBe('/work');
    const b = await makeService().service.createSession(
      { ...REQ, workingDir: '/custom' },
      { userId: USER_ID },
    );
    expect(b.session.workingDir).toBe('/custom');
  });

  it('launches the agent on flock-agentd with the session + node kind', async () => {
    const calls: Array<{ id: string; nodeKind: string }> = [];
    const agentdLaunch = async (args: {
      session: { id: string };
      nodeKind: string;
    }): Promise<AgentdLaunchOutcome> => {
      calls.push({ id: args.session.id, nodeKind: args.nodeKind });
      return 'launched';
    };
    const { service } = makeService({ nodeKind: 'ssh', agentdLaunch });
    const { session } = await service.createSession(REQ, { userId: USER_ID });
    expect(calls).toEqual([{ id: session.id, nodeKind: 'ssh' }]);
  });

  it('allows a supported older daemon through launch preflight', async () => {
    let launches = 0;
    const { service, db } = makeService({
      agentdLaunchPreflight: async () => null,
      agentdLaunch: async () => {
        launches += 1;
        return 'launched';
      },
    });

    await expect(service.createSession(REQ, { userId: USER_ID })).resolves.toBeDefined();
    expect(launches).toBe(1);
    expect(db.sessions).toHaveLength(1);
  });

  it('refuses a mandatory daemon upgrade before persisting a session', async () => {
    const { service, db } = makeService({
      agentdLaunchPreflight: async () => ({
        status: 'blocked',
        code: 'agentd_upgrade_required',
        message: 'Daemon 0.2.9 is below the supported minimum 0.3.0.',
        details: { installedVersion: '0.2.9', minimumVersion: '0.3.0' },
      }),
    });

    await expect(service.createSession(REQ, { userId: USER_ID })).rejects.toMatchObject({
      name: 'SessionLaunchBlockedError',
      code: 'agentd_upgrade_required',
      details: { installedVersion: '0.2.9', minimumVersion: '0.3.0' },
    });
    expect(db.sessions).toHaveLength(0);
  });

  it('removes the session and live binding when compatibility blocks during open', async () => {
    const tracked: string[] = [];
    const aborted: string[] = [];
    const { service, db } = makeService({
      agentdLaunchPreflight: async () => null,
      onSessionCreated: (session) => tracked.push(session.id),
      onSessionCreateAborted: (sessionId) => aborted.push(sessionId),
      agentdLaunch: async () => ({
        status: 'blocked',
        code: 'agentd_upgrade_required',
        message: 'The daemon became incompatible during launch.',
      }),
    });

    await expect(service.createSession(REQ, { userId: USER_ID })).rejects.toBeInstanceOf(
      SessionLaunchBlockedError,
    );
    expect(tracked).toHaveLength(1);
    expect(aborted).toEqual(tracked);
    expect(db.sessions).toHaveLength(0);
  });

  it('defaults to callback-only and injects a distinct token only for requested authority', async () => {
    const issued: string[][] = [];
    const envCalls: Array<{ hook: string; orchestration?: string }> = [];
    const { service } = makeService({
      issueOrchestrationCapability: async (_session, scopes) => {
        issued.push([...scopes]);
        return scopes.length > 0 ? 'separate-orchestration-token' : undefined;
      },
      sessionEnv: async (_session, hook, orchestration) => {
        envCalls.push({ hook, orchestration });
        return {};
      },
    });
    const callbackOnly = await service.createSession(REQ, { userId: USER_ID });
    const delegated = await service.createSession(
      { ...REQ, orchestrationAuthority: 'observe' },
      { userId: USER_ID },
    );

    expect(issued).toEqual([[], ['agents:list:project', 'agents:read:project']]);
    expect(envCalls[0]).toEqual({ hook: callbackOnly.hookToken, orchestration: undefined });
    expect(envCalls[1]).toEqual({
      hook: delegated.hookToken,
      orchestration: 'separate-orchestration-token',
    });
    expect(envCalls[1]!.hook).not.toBe(envCalls[1]!.orchestration);
    expect(delegated.session.orchestrationAuthority).toBe('observe');
  });

  it('rejects a session override above the durable project maximum', async () => {
    const { service, db } = makeService({
      projectPolicy: {
        ...DEFAULT_PROJECT_AGENT_POLICY,
        maxAuthority: 'collaborate',
      },
    });
    await expect(
      service.createSession({ ...REQ, orchestrationAuthority: 'manage' }, { userId: USER_ID }),
    ).rejects.toBeInstanceOf(SessionPolicyViolationError);
    expect(db.sessions).toHaveLength(0);
  });

  it('still persists the record when the agentd launch throws (no throw out)', async () => {
    const agentdLaunch = async (): Promise<AgentdLaunchOutcome> => {
      throw new Error('daemon down');
    };
    const { service, db } = makeService({ nodeKind: 'local', agentdLaunch });
    const { session } = await service.createSession(REQ, { userId: USER_ID });
    expect(session.id).toBeTruthy();
    expect(db.sessions).toHaveLength(1);
  });

  it('throws SessionProjectNotFoundError for an unknown project', async () => {
    // Empty the project store so resolution misses (the fake honors presence,
    // not the specific id filter — an empty store models "no such project").
    const { service } = makeService();
    (service as unknown as { db: FakeDb }).db = new FakeDb([{ id: NODE_ID, kind: 'local' }], []);
    await expect(service.createSession(REQ, { userId: USER_ID })).rejects.toBeInstanceOf(
      SessionProjectNotFoundError,
    );
  });
});

describe('SessionRestService.updateSession (note)', () => {
  it('sets and returns the note', async () => {
    const { service } = makeService();
    const { session } = await service.createSession(REQ, { userId: USER_ID });
    expect(session.note).toBeNull();

    const updated = await service.updateSession(session.id, { note: 'refactoring auth' });
    expect(updated?.note).toBe('refactoring auth');
  });

  it('clears the note with note: null', async () => {
    const { service } = makeService();
    const { session } = await service.createSession(REQ, { userId: USER_ID });
    await service.updateSession(session.id, { note: 'temp' });
    const cleared = await service.updateSession(session.id, { note: null });
    expect(cleared?.note).toBeNull();
  });

  it('returns null for an unknown session id', async () => {
    const { service } = makeService(); // no session created → empty store
    const updated = await service.updateSession('00000000-0000-4000-8000-000000000000', {
      note: 'missing',
    });
    expect(updated).toBeNull();
  });
});

describe('SessionRestService.listSessions', () => {
  it('returns mapped sessions', async () => {
    const { service } = makeService();
    await service.createSession(REQ, { userId: USER_ID });
    const list = await service.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.agentType).toBe('claude-code');
  });
});
