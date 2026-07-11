/**
 * OrchestrationService — the agent-facing API that lets one agent OBSERVE and
 * COORDINATE with its siblings (the herdr-style self-orchestration loop, MCP/CLI
 * surfaced separately). v1 is the SAFE, read/await half:
 *   - list   the agents in the caller's project (+ live status + latest message)
 *   - wait   block until a sibling reaches a status (idle/awaiting_input/done/…)
 *
 * Auth is a separately issued, opaque, hashed orchestration capability — never
 * the callback-only hook token or user cookie. Every verb requires its explicit
 * durable scope and remains bound to the caller session, project, installation,
 * expiry, and revocation state.
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import type { AgentCapabilityScope, ProjectAgentPolicy, Status } from '@flock/shared';

import type { Database } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import type { StatusMap } from '../status/map.js';

export class OrchestrationError extends Error {
  constructor(
    public readonly code: 'unauthorized' | 'not_found' | 'bad_request' | 'rate_limited',
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface AgentSummary {
  id: string;
  agentType: string;
  status: Status | null;
  message: string | null;
}

export interface AuthorizedCaller {
  projectId: string;
  createdBy: string;
  scopes: AgentCapabilityScope[];
  policy: ProjectAgentPolicy;
}

export const ORCHESTRATION_SCOPES = {
  list: 'agents:list:project',
  wait: 'agents:read:project',
  read: 'agents:read:project',
  send: 'agents:send:project',
  spawn: 'agents:spawn:project',
  kill: 'agents:terminate:project',
  restart: ['agents:terminate:project', 'agents:spawn:project'],
} as const satisfies Record<
  'list' | 'wait' | 'read' | 'send' | 'spawn' | 'kill' | 'restart',
  AgentCapabilityScope | readonly AgentCapabilityScope[]
>;

/** Statuses an agent may wait on (the meaningful coordination points). */
const WAITABLE: ReadonlySet<string> = new Set([
  'idle',
  'awaiting_input',
  'done',
  'error',
  'running',
]);

export class OrchestrationService {
  constructor(
    private readonly db: Database,
    private readonly statusMap: StatusMap,
    private readonly authorizeCapability: (
      callerId: string,
      token: string,
      required: AgentCapabilityScope,
    ) => Promise<AuthorizedCaller>,
    private readonly latestChats: () => Promise<Record<string, { role: string; text: string }>>,
    /** Launch a new agent in the project; returns the new session id. */
    private readonly spawnFn: (
      projectId: string,
      createdBy: string,
      agentType: string,
    ) => Promise<string>,
    /** Deliver text (as input) to a session; returns whether it was sent. */
    private readonly sendFn: (targetId: string, text: string) => Promise<boolean>,
    /** Terminate a session; returns whether it was terminated. */
    private readonly killFn: (targetId: string) => Promise<boolean>,
    /** Recent chat/assistant output for a session (oldest→newest). */
    private readonly readOutputFn: (
      targetId: string,
      limit: number,
    ) => Promise<Array<{ role: string; text: string }>>,
    private readonly spawnRateWindowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly auditDenied: (
      callerId: string,
      required: AgentCapabilityScope,
    ) => void = () => {},
  ) {}

  /** Per-project recent spawn timestamps for the sliding-window rate limit. */
  private readonly spawnTimes = new Map<string, number[]>();
  private lastSpawnSweepAt = 0;
  private readonly maxSpawnRateKeys = 5_000;

  private pruneSpawnRates(now: number): void {
    if (now - this.lastSpawnSweepAt < this.spawnRateWindowMs) return;
    this.lastSpawnSweepAt = now;
    const cutoff = now - this.spawnRateWindowMs;
    for (const [projectId, timestamps] of this.spawnTimes) {
      const recent = timestamps.filter((timestamp) => timestamp >= cutoff);
      if (recent.length === 0) this.spawnTimes.delete(projectId);
      else this.spawnTimes.set(projectId, recent);
    }
  }

  private makeSpawnRateRoom(): void {
    if (this.spawnTimes.size < this.maxSpawnRateKeys) return;
    let oldestProject: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [projectId, timestamps] of this.spawnTimes) {
      const timestamp = timestamps.at(-1) ?? Number.NEGATIVE_INFINITY;
      if (timestamp < oldestTimestamp) {
        oldestProject = projectId;
        oldestTimestamp = timestamp;
      }
    }
    if (oldestProject !== undefined) this.spawnTimes.delete(oldestProject);
  }

  /** Throw if the project exceeded its spawn rate, bounding delegated spawn authority. */
  private checkSpawnRate(projectId: string, limit: number): void {
    const now = this.now();
    this.pruneSpawnRates(now);
    const cutoff = now - this.spawnRateWindowMs;
    const recent = (this.spawnTimes.get(projectId) ?? []).filter((t) => t >= cutoff);
    if (recent.length >= limit) {
      throw new OrchestrationError(
        'rate_limited',
        `spawn rate limit reached (${limit} per ${Math.round(this.spawnRateWindowMs / 1000)}s) for this project`,
        recent[0]! + this.spawnRateWindowMs - now,
      );
    }
    if (!this.spawnTimes.has(projectId)) this.makeSpawnRateRoom();
    recent.push(now);
    this.spawnTimes.set(projectId, recent);
  }

  /** Look up a target that MUST be in the caller's project; returns its row. */
  private async requireTargetInProject(
    projectId: string,
    targetId: string,
  ): Promise<{ agentType: string }> {
    const [tgt] = await this.db
      .select({ projectId: agentSessions.projectId, agentType: agentSessions.agentType })
      .from(agentSessions)
      .where(eq(agentSessions.id, targetId))
      .limit(1);
    if (!tgt || tgt.projectId !== projectId) {
      throw new OrchestrationError('not_found', 'target agent is not in your project');
    }
    return { agentType: tgt.agentType };
  }

  /** Verify a separate orchestration capability and return its durable scope. */
  private async authCaller(
    callerId: string,
    token: string,
    required: AgentCapabilityScope,
  ): Promise<AuthorizedCaller> {
    try {
      return await this.authorizeCapability(callerId, token, required);
    } catch {
      this.auditDenied(callerId, required);
      throw new OrchestrationError('unauthorized', 'invalid session token');
    }
  }

  /** The caller's sibling agents (same project): id, type, live status, latest message. */
  async listAgents(callerId: string, token: string): Promise<AgentSummary[]> {
    const { projectId } = await this.authCaller(callerId, token, ORCHESTRATION_SCOPES.list);
    const rows = await this.db
      .select({ id: agentSessions.id, agentType: agentSessions.agentType })
      .from(agentSessions)
      .where(and(eq(agentSessions.projectId, projectId), isNull(agentSessions.closedAt)));
    const chats = await this.latestChats().catch(() => ({}) as Record<string, { text: string }>);
    return rows.map((r) => ({
      id: r.id,
      agentType: r.agentType,
      status: (this.statusMap.get(r.id)?.status as Status) ?? null,
      message: chats[r.id]?.text ?? null,
    }));
  }

  /** Block until `targetId` (must be in the caller's project) hits `status`, or timeout. */
  async wait(
    callerId: string,
    token: string,
    targetId: string,
    status: string,
    timeoutMs: number,
  ): Promise<{ status: Status | null; reached: boolean }> {
    const { projectId } = await this.authCaller(callerId, token, ORCHESTRATION_SCOPES.wait);
    if (!WAITABLE.has(status))
      throw new OrchestrationError('bad_request', `cannot wait on status: ${status}`);
    const [tgt] = await this.db
      .select({ projectId: agentSessions.projectId })
      .from(agentSessions)
      .where(eq(agentSessions.id, targetId))
      .limit(1);
    if (!tgt || tgt.projectId !== projectId) {
      throw new OrchestrationError('not_found', 'target agent is not in your project');
    }
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1_000), 120_000);
    let everSeen = false;
    for (;;) {
      const cur = (this.statusMap.get(targetId)?.status as Status) ?? null;
      if (cur !== null) everSeen = true;
      if (cur === status) return { status: cur, reached: true };
      // The agent finished and was dropped from the live map. Don't spin to the
      // full timeout: closure satisfies a `done` wait; any other target wasn't met.
      if (cur === null && everSeen) return { status: null, reached: status === 'done' };
      if (Date.now() >= deadline) return { status: cur, reached: false };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** Launch a sibling agent in the caller's project (capped). Returns its id. The
   *  caller typically then waits for it to be `idle`, sends it a task, and waits
   *  again for `idle`/`done`. */
  async spawn(callerId: string, token: string, agentType: string): Promise<{ id: string }> {
    const { projectId, createdBy, policy } = await this.authCaller(
      callerId,
      token,
      ORCHESTRATION_SCOPES.spawn,
    );
    if (!agentType || typeof agentType !== 'string') {
      throw new OrchestrationError('bad_request', 'agentType is required');
    }
    this.checkSpawnRate(projectId, policy.spawnRateLimitPerMinute);
    const [row] = await this.db
      .select({ n: count() })
      .from(agentSessions)
      .where(and(eq(agentSessions.projectId, projectId), isNull(agentSessions.closedAt)));
    if (Number(row?.n ?? 0) >= policy.maxConcurrentAgents) {
      throw new OrchestrationError(
        'bad_request',
        `project is at the spawn cap (${policy.maxConcurrentAgents} open agents)`,
      );
    }
    try {
      const id = await this.spawnFn(projectId, createdBy, agentType);
      // Collaboration edge is cosmetic (teams graph) — never fail a live spawn on it.
      return { id };
    } catch (e) {
      throw new OrchestrationError('bad_request', e instanceof Error ? e.message : 'spawn failed');
    }
  }

  /** Deliver text (a task / reply) to a sibling agent in the caller's project. */
  async send(
    callerId: string,
    token: string,
    targetId: string,
    text: string,
  ): Promise<{ delivered: boolean }> {
    const { projectId, policy } = await this.authCaller(callerId, token, ORCHESTRATION_SCOPES.send);
    if (typeof text !== 'string' || text.length === 0) {
      throw new OrchestrationError('bad_request', 'text is required');
    }
    if (Buffer.byteLength(text, 'utf8') > policy.maxSendBytes) {
      throw new OrchestrationError(
        'bad_request',
        `message exceeds the project limit (${policy.maxSendBytes} bytes)`,
      );
    }
    const [tgt] = await this.db
      .select({ projectId: agentSessions.projectId })
      .from(agentSessions)
      .where(eq(agentSessions.id, targetId))
      .limit(1);
    if (!tgt || tgt.projectId !== projectId) {
      throw new OrchestrationError('not_found', 'target agent is not in your project');
    }
    return { delivered: await this.sendFn(targetId, text) };
  }

  /** Read a sibling's recent output (its assistant/chat messages, oldest→newest) so
   *  the caller can inspect what a worker produced before acting on it. */
  async readOutput(
    callerId: string,
    token: string,
    targetId: string,
    limit: number,
  ): Promise<{ messages: Array<{ role: string; text: string }> }> {
    const { projectId, policy } = await this.authCaller(callerId, token, ORCHESTRATION_SCOPES.read);
    await this.requireTargetInProject(projectId, targetId);
    const lim = Math.min(Math.max(limit || 10, 1), policy.maxReadMessages);
    return { messages: await this.readOutputFn(targetId, lim) };
  }

  /** Terminate a sibling agent in the caller's project (clean up a finished worker). */
  async kill(callerId: string, token: string, targetId: string): Promise<{ killed: boolean }> {
    const { projectId } = await this.authCaller(callerId, token, ORCHESTRATION_SCOPES.kill);
    await this.requireTargetInProject(projectId, targetId);
    return { killed: await this.killFn(targetId) };
  }

  /** Restart a sibling: terminate it and spawn a fresh agent of the SAME type in the
   *  caller's project. Returns the new session id (the old one is gone). */
  async restart(callerId: string, token: string, targetId: string): Promise<{ id: string }> {
    const { projectId, createdBy, scopes } = await this.authCaller(
      callerId,
      token,
      ORCHESTRATION_SCOPES.restart[0],
    );
    if (!scopes.includes(ORCHESTRATION_SCOPES.restart[1])) {
      this.auditDenied(callerId, ORCHESTRATION_SCOPES.restart[1]);
      throw new OrchestrationError('unauthorized', 'restart also requires spawn capability');
    }
    const { agentType } = await this.requireTargetInProject(projectId, targetId);
    await this.killFn(targetId);
    const id = await this.spawnFn(projectId, createdBy, agentType);
    return { id };
  }
}
