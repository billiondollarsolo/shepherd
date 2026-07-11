/**
 * Config-as-code (flock.yml) — apply a reproducible workspace definition and
 * export the current fleet back to YAML. A flock.yml looks like:
 *
 *   projects:
 *     - node: node-vm-1            # node NAME (or id)
 *       name: rss-test
 *       path: /home/flock/rss-test # working dir
 *       agents:
 *         - type: claude-code
 *           mode: plan             # optional permissionMode
 *         - type: codex
 *
 * apply() is idempotent at the coarse level: a project is reused if one of the
 * same name already exists on the node, and an agent is skipped if an OPEN
 * session of that type already runs in the project.
 */
import { parse, stringify } from 'yaml';
import { CreateSessionRequest, type CreateProjectRequest } from '@flock/shared';

export interface FlockConfigAgent {
  type: string;
  mode?: string;
  systemPrompt?: string;
}
export interface FlockConfigProject {
  node: string;
  name: string;
  path: string;
  agents?: FlockConfigAgent[];
}
export interface FlockConfig {
  projects?: FlockConfigProject[];
}

export interface ConfigApplySummary {
  projectsCreated: string[];
  sessionsCreated: string[];
  warnings: string[];
}

export class ConfigError extends Error {}

interface NodeLite {
  id: string;
  name: string;
}
interface ProjectLite {
  id: string;
  nodeId: string;
  name: string;
  workingDir: string;
}
interface SessionLite {
  projectId: string;
  agentType: string;
  permissionMode?: string | null;
  closedAt: string | null;
}

export interface ConfigServiceDeps {
  listNodes(): Promise<NodeLite[]>;
  listProjects(nodeId?: string): Promise<ProjectLite[]>;
  createProject(input: CreateProjectRequest): Promise<{ id: string }>;
  listSessions(): Promise<SessionLite[]>;
  createSession(
    input: CreateSessionRequest,
    ctx: { userId: string; ip: string | null },
  ): Promise<{ session: { id: string } }>;
}

export class ConfigService {
  constructor(private readonly deps: ConfigServiceDeps) {}

  /** Parse + apply a flock.yml, creating missing projects/sessions. */
  async apply(
    yamlText: string,
    ctx: { userId: string; ip: string | null },
  ): Promise<ConfigApplySummary> {
    let cfg: FlockConfig;
    try {
      cfg = (parse(yamlText) ?? {}) as FlockConfig;
    } catch (e) {
      throw new ConfigError(`invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!cfg.projects || !Array.isArray(cfg.projects)) {
      throw new ConfigError('config must have a top-level "projects" list');
    }
    const summary: ConfigApplySummary = { projectsCreated: [], sessionsCreated: [], warnings: [] };
    const nodes = await this.deps.listNodes();
    const open = (await this.deps.listSessions()).filter((s) => s.closedAt === null);

    for (const pc of cfg.projects) {
      if (!pc?.node || !pc?.name || !pc?.path) {
        summary.warnings.push('skipped a project entry missing node/name/path');
        continue;
      }
      const node = nodes.find((n) => n.name === pc.node || n.id === pc.node);
      if (!node) {
        summary.warnings.push(`unknown node "${pc.node}" (project ${pc.name})`);
        continue;
      }
      const existing = (await this.deps.listProjects(node.id)).find((p) => p.name === pc.name);
      let projectId: string;
      if (existing) {
        projectId = existing.id;
      } else {
        try {
          projectId = (
            await this.deps.createProject({ nodeId: node.id, name: pc.name, workingDir: pc.path })
          ).id;
          summary.projectsCreated.push(`${pc.name} @ ${pc.node}`);
        } catch (e) {
          summary.warnings.push(
            `project ${pc.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
      }
      for (const ac of pc.agents ?? []) {
        if (!ac?.type) continue;
        if (open.some((s) => s.projectId === projectId && s.agentType === ac.type)) {
          summary.warnings.push(`${ac.type} already running in ${pc.name} — skipped`);
          continue;
        }
        const parsed = CreateSessionRequest.safeParse({
          projectId,
          agentType: ac.type,
          permissionMode: ac.mode,
          systemPrompt: ac.systemPrompt,
        });
        if (!parsed.success) {
          summary.warnings.push(`invalid agent "${ac.type}" in ${pc.name}`);
          continue;
        }
        try {
          await this.deps.createSession(parsed.data, ctx);
          summary.sessionsCreated.push(`${ac.type} in ${pc.name}`);
        } catch (e) {
          summary.warnings.push(
            `agent ${ac.type} in ${pc.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    return summary;
  }

  /** Serialize the current fleet (projects + their open agents) to flock.yml. */
  async export(): Promise<string> {
    const nodes = await this.deps.listNodes();
    const nodeName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? id;
    const projects = await this.deps.listProjects();
    const open = (await this.deps.listSessions()).filter((s) => s.closedAt === null);
    const cfg: FlockConfig = {
      projects: projects.map((p) => ({
        node: nodeName(p.nodeId),
        name: p.name,
        path: p.workingDir,
        agents: open
          .filter((s) => s.projectId === p.id)
          .map((s) =>
            s.permissionMode && s.permissionMode !== 'default'
              ? { type: s.agentType, mode: s.permissionMode }
              : { type: s.agentType },
          ),
      })),
    };
    return stringify(cfg);
  }
}
