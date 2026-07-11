/**
 * OrchestrationService — the agent-facing API that lets one agent OBSERVE and
 * COORDINATE with its siblings (the herdr-style self-orchestration loop, MCP/CLI
 * surfaced separately). v1 is the SAFE, read/await half:
 *   - list   the agents in the caller's project (+ live status + latest message)
 *   - wait   block until a sibling reaches a status (idle/awaiting_input/done/…)
 *
 * Auth is the caller's PER-SESSION hook token (the same `FLOCK_HOOK_TOKEN` the
 * agent already has) — NOT the user cookie — and every call is SCOPED to the
 * caller's own project (an agent can never see or wait on another project).
 *
 * ⚠️ BLAST RADIUS: the hook token doubles as the orchestration-capability token,
 * so a session that can post status hooks can ALSO spawn/send/kill any sibling in
 * its OWN project (never another project). Mitigations: per-project concurrent cap
 * (`maxPerProject`) + a per-project spawn RATE limit (below). A future hardening
 * would issue a separate, narrower callback-only token; for now the project scope
 * + caps bound the damage.
 */
import { and, count, eq, isNull, isNotNull } from 'drizzle-orm';
import type { Status } from '@flock/shared';

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

/** Statuses an agent may wait on (the meaningful coordination points). */
const WAITABLE: ReadonlySet<string> = new Set([
  'idle',
  'awaiting_input',
  'done',
  'error',
  'running',
]);

export class OrchestrationService {
  /** Spawn/handoff edges (parent → child) for the collaboration graph. Backed by
   *  `agent_sessions.parent_session_id` so the teams graph SURVIVES restarts
   *  (was an in-memory Map that evaporated on every reboot). */
  async spawnEdges(): Promise<Array<{ parent: string; child: string }>> {
    const rows = await this.db
      .select({ child: agentSessions.id, parent: agentSessions.parentSessionId })
      .from(agentSessions)
      .where(isNotNull(agentSessions.parentSessionId));
    return rows
      .filter((r): r is { child: string; parent: string } => Boolean(r.parent))
      .map((r) => ({ parent: r.parent, child: r.child }));
  }

  /** Record a parent→child edge (agent spawn OR user handoff) so the spatial graph
   *  shows the lineage. Persisted on the child row. Best-effort. */
  async recordHandoff(parentId: string, childId: string): Promise<void> {
    await this.db
      .update(agentSessions)
      .set({ parentSessionId: parentId })
      .where(eq(agentSessions.id, childId));
  }

  constructor(
    private readonly db: Database,
    private readonly statusMap: StatusMap,
    private readonly verifyToken: (hash: string, token: string) => Promise<boolean>,
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
    /** Runaway guard: max OPEN agents per project (spawn rejects beyond this). */
    private readonly maxPerProject = 12,
    /** Anti-runaway: max spawns per project within `spawnRateWindowMs`. */
    private readonly spawnRateLimit = 10,
    private readonly spawnRateWindowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
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

  /** Throw if the project exceeded its spawn rate. The hook token grants the spawn
   *  verb, so this bounds a runaway/compromised agent's blast radius. */
  private checkSpawnRate(projectId: string): void {
    const now = this.now();
    this.pruneSpawnRates(now);
    const cutoff = now - this.spawnRateWindowMs;
    const recent = (this.spawnTimes.get(projectId) ?? []).filter((t) => t >= cutoff);
    if (recent.length >= this.spawnRateLimit) {
      throw new OrchestrationError(
        'rate_limited',
        `spawn rate limit reached (${this.spawnRateLimit} per ${Math.round(this.spawnRateWindowMs / 1000)}s) for this project`,
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

  /** Verify the caller's hook token and return its project scope + owner. */
  private async authCaller(
    callerId: string,
    token: string,
  ): Promise<{ projectId: string; createdBy: string }> {
    const [row] = await this.db
      .select({
        projectId: agentSessions.projectId,
        hash: agentSessions.hookTokenHash,
        closedAt: agentSessions.closedAt,
        createdBy: agentSessions.createdBy,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, callerId))
      .limit(1);
    if (!row || row.closedAt || !row.createdBy)
      throw new OrchestrationError('unauthorized', 'unknown or closed caller session');
    if (!token || !(await this.verifyToken(row.hash, token))) {
      throw new OrchestrationError('unauthorized', 'invalid session token');
    }
    return { projectId: row.projectId, createdBy: row.createdBy };
  }

  /** The caller's sibling agents (same project): id, type, live status, latest message. */
  async listAgents(callerId: string, token: string): Promise<AgentSummary[]> {
    const { projectId } = await this.authCaller(callerId, token);
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
    const { projectId } = await this.authCaller(callerId, token);
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
    const { projectId, createdBy } = await this.authCaller(callerId, token);
    if (!agentType || typeof agentType !== 'string') {
      throw new OrchestrationError('bad_request', 'agentType is required');
    }
    this.checkSpawnRate(projectId);
    const [row] = await this.db
      .select({ n: count() })
      .from(agentSessions)
      .where(and(eq(agentSessions.projectId, projectId), isNull(agentSessions.closedAt)));
    if (Number(row?.n ?? 0) >= this.maxPerProject) {
      throw new OrchestrationError(
        'bad_request',
        `project is at the spawn cap (${this.maxPerProject} open agents)`,
      );
    }
    try {
      const id = await this.spawnFn(projectId, createdBy, agentType);
      // Collaboration edge is cosmetic (teams graph) — never fail a live spawn on it.
      void this.recordHandoff(callerId, id).catch(() => undefined);
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
    const { projectId } = await this.authCaller(callerId, token);
    if (typeof text !== 'string' || text.length === 0) {
      throw new OrchestrationError('bad_request', 'text is required');
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
    const { projectId } = await this.authCaller(callerId, token);
    await this.requireTargetInProject(projectId, targetId);
    const lim = Math.min(Math.max(limit || 10, 1), 50);
    return { messages: await this.readOutputFn(targetId, lim) };
  }

  /** Terminate a sibling agent in the caller's project (clean up a finished worker). */
  async kill(callerId: string, token: string, targetId: string): Promise<{ killed: boolean }> {
    const { projectId } = await this.authCaller(callerId, token);
    await this.requireTargetInProject(projectId, targetId);
    return { killed: await this.killFn(targetId) };
  }

  /** Restart a sibling: terminate it and spawn a fresh agent of the SAME type in the
   *  caller's project. Returns the new session id (the old one is gone). */
  async restart(callerId: string, token: string, targetId: string): Promise<{ id: string }> {
    const { projectId, createdBy } = await this.authCaller(callerId, token);
    const { agentType } = await this.requireTargetInProject(projectId, targetId);
    await this.killFn(targetId);
    const id = await this.spawnFn(projectId, createdBy, agentType);
    void this.recordHandoff(callerId, id).catch(() => undefined);
    return { id };
  }
}
