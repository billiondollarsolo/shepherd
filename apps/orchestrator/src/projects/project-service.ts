/**
 * ProjectService — REST CRUD for node-scoped projects (spec §6, FR-N3).
 *
 *   GET  /api/projects[?nodeId=...]   list projects (optionally one node's)
 *   POST /api/projects                create a project on an existing node
 *
 * A project is just a (node, name, working_dir). Creating one against an unknown
 * node id is rejected with {@link ProjectNodeNotFoundError} (→ 404) rather than
 * letting the FK blow up, so the paddock gets a clean error.
 *
 * Postgres here is the durable system of record, never the live status path
 * (spec §6.6). Rows are mapped to the shared `Project` via `rowToProject` so the
 * domain type is never duplicated.
 */
import { eq } from 'drizzle-orm';

import {
  DEFAULT_PROJECT_AGENT_POLICY,
  ProjectAgentPolicySchema,
  type CreateProjectRequest,
  type Project as SharedProject,
  type ProjectAgentPolicy,
} from '@flock/shared';

import type { Database } from '../db/client.js';
import type { AuditLogger } from '../audit/audit.js';
import { rowToProject } from '../db/mappers.js';
import { nodes, projects } from '../db/schema.js';

/** Raised when the target node id does not resolve to a node (→ 404, spec §10). */
export class ProjectNodeNotFoundError extends Error {
  constructor(public readonly nodeId: string) {
    super(`Node "${nodeId}" was not found.`);
    this.name = 'ProjectNodeNotFoundError';
  }
}

export interface ProjectServiceDeps {
  db: Database;
  audit?: AuditLogger;
}

export class ProjectService {
  private readonly db: Database;
  private readonly audit?: AuditLogger;

  constructor(deps: ProjectServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
  }

  /** List projects, optionally narrowed to a single node. */
  async listProjects(nodeId?: string): Promise<SharedProject[]> {
    const rows = nodeId
      ? await this.db.select().from(projects).where(eq(projects.nodeId, nodeId))
      : await this.db.select().from(projects);
    return rows.map(rowToProject);
  }

  /**
   * Create a project on an existing node. Throws {@link ProjectNodeNotFoundError}
   * (→ 404) when the node id is unknown; otherwise persists and returns the
   * mapped record.
   */
  async createProject(input: CreateProjectRequest): Promise<SharedProject> {
    const node = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, input.nodeId))
      .limit(1);
    if (!node[0]) {
      throw new ProjectNodeNotFoundError(input.nodeId);
    }

    const [row] = await this.db
      .insert(projects)
      .values({
        nodeId: input.nodeId,
        name: input.name,
        workingDir: input.workingDir,
        agentPolicy: input.agentPolicy ?? DEFAULT_PROJECT_AGENT_POLICY,
      })
      .returning();
    if (!row) {
      throw new Error('Failed to persist project record.');
    }
    return rowToProject(row);
  }

  /** Replace the durable server-owned policy after full contract validation. */
  async updateAgentPolicy(
    projectId: string,
    policy: ProjectAgentPolicy,
    context?: { userId?: string | null; ip?: string | null },
  ): Promise<SharedProject | null> {
    const parsed = ProjectAgentPolicySchema.parse(policy);
    const [row] = await this.db
      .update(projects)
      .set({ agentPolicy: parsed })
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) return null;
    void this.audit
      ?.record({
        action: 'agent_policy_event',
        userId: context?.userId,
        ip: context?.ip,
        targetType: 'project',
        targetId: projectId,
        detail: {
          event: 'updated',
          defaultAuthority: parsed.defaultAuthority,
          maxAuthority: parsed.maxAuthority,
        },
      })
      .catch(() => undefined);
    return rowToProject(row);
  }
}
