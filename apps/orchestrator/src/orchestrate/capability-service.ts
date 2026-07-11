import { createHash, randomBytes } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';

import type { AgentCapabilityScope } from '@flock/shared';

import type { Database } from '../db/client.js';
import { agentCapabilities, agentSessions } from '../db/schema.js';

export interface AuthorizedAgentCapability {
  sessionId: string;
  projectId: string;
  createdBy: string;
  scopes: AgentCapabilityScope[];
}

export class AgentCapabilityError extends Error {
  constructor(message = 'invalid or insufficient agent capability') {
    super(message);
    this.name = 'AgentCapabilityError';
  }
}

export interface AgentCapabilityServiceDeps {
  db: Database;
  installationId: string;
  now?: () => Date;
  ttlMs?: number;
}

/** Issues opaque orchestration credentials and enforces their durable scopes. */
export class AgentCapabilityService {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly deps: AgentCapabilityServiceDeps) {
    if (!deps.installationId.trim())
      throw new Error('agent capability installation id is required');
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = deps.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  async issue(
    sessionId: string,
    projectId: string,
    scopes: readonly AgentCapabilityScope[],
  ): Promise<string | undefined> {
    const unique = [...new Set(scopes)];
    if (unique.length === 0) return undefined;
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.deps.db.insert(agentCapabilities).values({
      sessionId,
      projectId,
      installationId: this.deps.installationId,
      tokenHash: hashCapabilityToken(token),
      scopes: unique,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    });
    return token;
  }

  async authorize(
    sessionId: string,
    token: string,
    required: AgentCapabilityScope,
  ): Promise<AuthorizedAgentCapability> {
    if (!token) throw new AgentCapabilityError();
    const [row] = await this.deps.db
      .select({
        sessionId: agentCapabilities.sessionId,
        projectId: agentCapabilities.projectId,
        installationId: agentCapabilities.installationId,
        scopes: agentCapabilities.scopes,
        createdBy: agentSessions.createdBy,
      })
      .from(agentCapabilities)
      .innerJoin(agentSessions, eq(agentSessions.id, agentCapabilities.sessionId))
      .where(
        and(
          eq(agentCapabilities.sessionId, sessionId),
          eq(agentCapabilities.tokenHash, hashCapabilityToken(token)),
          eq(agentCapabilities.installationId, this.deps.installationId),
          isNull(agentCapabilities.revokedAt),
          gt(agentCapabilities.expiresAt, this.now()),
          isNull(agentSessions.closedAt),
        ),
      )
      .limit(1);
    const scopes = (row?.scopes ?? []) as AgentCapabilityScope[];
    if (!row || !scopes.includes(required)) throw new AgentCapabilityError();
    return {
      sessionId: row.sessionId,
      projectId: row.projectId,
      createdBy: row.createdBy,
      scopes,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.deps.db
      .update(agentCapabilities)
      .set({ revokedAt: this.now() })
      .where(and(eq(agentCapabilities.sessionId, sessionId), isNull(agentCapabilities.revokedAt)));
  }
}

export function hashCapabilityToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
