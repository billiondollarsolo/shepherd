import type {
  ProjectPort,
  ProjectPortDiscovery,
  ProjectPortProtocol,
  SaveProjectPortRequest,
  UpdateProjectPortRequest,
} from '@flock/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { AuditLogger } from '../audit/audit.js';
import type { Database } from '../db/client.js';
import { agentSessions, nodes, projectServices, projects } from '../db/schema.js';
import type { AgentdListeningPort } from '../nodes/agentd/protocol.js';
import {
  PreviewForbiddenError,
  PreviewServiceNotFoundError,
  type PreviewService,
} from './service.js';

export interface ListenerDiscoverySnapshot {
  supported: boolean;
  healthy: boolean;
  reason: string | null;
  observedAt: string | null;
  ports: AgentdListeningPort[];
}

export interface ProjectPortsServiceDeps {
  db: Database;
  audit: AuditLogger;
  previews: PreviewService;
  discover(nodeId: string): Promise<ListenerDiscoverySnapshot>;
  now?: () => number;
  discoveryTtlMs?: number;
}

interface CachedDiscovery {
  at: number;
  value: ListenerDiscoverySnapshot;
}

export class ProjectNotFoundError extends Error {}
export class ProjectPortNotFoundError extends Error {}

export class ProjectPortsService {
  private readonly now: () => number;
  private readonly discoveryTtlMs: number;
  private readonly discoveryCache = new Map<string, CachedDiscovery>();
  private readonly discoveryPending = new Map<string, Promise<ListenerDiscoverySnapshot>>();

  constructor(private readonly deps: ProjectPortsServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.discoveryTtlMs = deps.discoveryTtlMs ?? 4_000;
  }

  async list(
    projectId: string,
    userId: string,
    refresh = false,
  ): Promise<{ ports: ProjectPort[]; discovery: ProjectPortDiscovery }> {
    const project = await this.requireOwnedProject(projectId, userId);
    const [saved, nodeProjects, sessions, discovery] = await Promise.all([
      this.deps.db.select().from(projectServices).where(eq(projectServices.projectId, projectId)),
      this.deps.db
        .select({ id: projects.id, workingDir: projects.workingDir })
        .from(projects)
        .where(eq(projects.nodeId, project.nodeId)),
      this.deps.db
        .select({ id: agentSessions.id, projectId: agentSessions.projectId })
        .from(agentSessions)
        .where(and(eq(agentSessions.nodeId, project.nodeId), isNull(agentSessions.closedAt))),
      this.discovery(project.nodeId, refresh),
    ]);
    const association = associateProjectListeners(
      discovery.ports,
      projectId,
      nodeProjects,
      sessions,
    );
    const detected = association.assigned;
    const detectedByKey = new Map(
      detected.map((listener) => [portKey(listener.targetHost, listener.port, 'http'), listener]),
    );
    const result: ProjectPort[] = [];

    for (const service of saved) {
      const protocol = service.protocol as ProjectPortProtocol;
      const key = portKey(service.targetHost, service.targetPort, protocol);
      const listener =
        detectedByKey.get(key) ??
        detected.find(
          (candidate) =>
            candidate.targetHost === service.targetHost && candidate.port === service.targetPort,
        );
      if (listener) detectedByKey.delete(portKey(listener.targetHost, listener.port, 'http'));
      const forward = this.deps.previews.activeForService(service.id);
      const inactiveStatus = this.deps.previews.inactiveStatus(service.id);
      result.push({
        id: service.id,
        serviceId: service.id,
        projectId,
        nodeId: project.nodeId,
        targetHost: service.targetHost as '127.0.0.1' | '::1',
        targetPort: service.targetPort,
        protocol,
        label: service.label,
        source: 'saved',
        process: listener ? compactProcess(listener) : null,
        remembered: true,
        autoForward: service.autoForward,
        status: forward ? 'forwarding' : (inactiveStatus ?? (listener ? 'detected' : 'stopped')),
        lastSeenAt: listener ? discovery.observedAt : null,
        forward,
      });
    }

    for (const listener of detectedByKey.values()) {
      result.push({
        id: `detected:${listener.observationKey.slice(0, 240)}`,
        serviceId: null,
        projectId,
        nodeId: project.nodeId,
        targetHost: listener.targetHost,
        targetPort: listener.port,
        protocol: 'http',
        label: inferredLabel(listener.process, listener.port),
        source: 'detected',
        process: compactProcess(listener),
        remembered: false,
        autoForward: false,
        status: 'detected',
        lastSeenAt: discovery.observedAt,
        forward: null,
      });
    }

    result.sort(
      (left, right) => left.targetPort - right.targetPort || left.label.localeCompare(right.label),
    );
    return {
      ports: result,
      discovery: {
        supported: discovery.supported,
        healthy: discovery.healthy,
        reason: discovery.reason,
        observedAt: discovery.observedAt,
        unassignedCount: association.unassignedCount,
        ambiguousCount: association.ambiguousCount,
      },
    };
  }

  async save(
    projectId: string,
    input: SaveProjectPortRequest,
    actor: { userId: string; ip?: string | null },
  ): Promise<ProjectPort> {
    const project = await this.requireOwnedProject(projectId, actor.userId);
    const label = input.label ?? inferredLabel(undefined, input.targetPort);
    const [row] = await this.deps.db
      .insert(projectServices)
      .values({
        projectId,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        protocol: input.protocol,
        label,
        autoForward: input.autoForward,
      })
      .onConflictDoUpdate({
        target: [
          projectServices.projectId,
          projectServices.targetHost,
          projectServices.targetPort,
          projectServices.protocol,
        ],
        set: { label, autoForward: input.autoForward, updatedAt: new Date(this.now()) },
      })
      .returning();
    if (!row) throw new Error('Failed to save project service.');
    await this.deps.audit.record({
      action: 'preview_service_save',
      userId: actor.userId,
      targetType: 'project',
      targetId: projectId,
      ip: actor.ip ?? null,
      detail: {
        serviceId: row.id,
        targetHost: row.targetHost,
        targetPort: row.targetPort,
        protocol: row.protocol,
        autoForward: row.autoForward,
      },
    });
    return this.savedPort(row, project.nodeId);
  }

  async activateRemembered(
    projectId: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<void> {
    await this.requireOwnedProject(projectId, actor.userId);
    const runtime = await this.deps.previews.runtimeSettings(actor.userId);
    if (!runtime.enabled || runtime.autoForwardPolicy !== 'remembered_on_access') return;
    const saved = await this.deps.db
      .select({ id: projectServices.id })
      .from(projectServices)
      .where(and(eq(projectServices.projectId, projectId), eq(projectServices.autoForward, true)));
    for (const service of saved) {
      if (this.deps.previews.activeForService(service.id)) continue;
      await this.deps.previews.start(service.id, undefined, actor).catch(() => undefined);
    }
  }

  async update(
    projectId: string,
    serviceId: string,
    input: UpdateProjectPortRequest,
    actor: { userId: string; ip?: string | null },
  ): Promise<ProjectPort> {
    const project = await this.requireOwnedProject(projectId, actor.userId);
    const [row] = await this.deps.db
      .update(projectServices)
      .set({ ...input, updatedAt: new Date(this.now()) })
      .where(and(eq(projectServices.id, serviceId), eq(projectServices.projectId, projectId)))
      .returning();
    if (!row) throw new ProjectPortNotFoundError('Project service not found.');
    await this.deps.audit.record({
      action: 'preview_service_save',
      userId: actor.userId,
      targetType: 'project',
      targetId: projectId,
      ip: actor.ip ?? null,
      detail: { event: 'updated', serviceId, ...input },
    });
    return this.savedPort(row, project.nodeId);
  }

  async forget(
    projectId: string,
    serviceId: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<void> {
    await this.requireOwnedProject(projectId, actor.userId);
    const [existing] = await this.deps.db
      .select({ id: projectServices.id })
      .from(projectServices)
      .where(and(eq(projectServices.id, serviceId), eq(projectServices.projectId, projectId)))
      .limit(1);
    if (!existing) throw new ProjectPortNotFoundError('Project service not found.');
    await this.deps.previews.revoke(serviceId, actor, 'service_forgotten');
    await this.deps.db.delete(projectServices).where(eq(projectServices.id, serviceId));
    await this.deps.audit.record({
      action: 'preview_service_forget',
      userId: actor.userId,
      targetType: 'project',
      targetId: projectId,
      ip: actor.ip ?? null,
      detail: { serviceId },
    });
  }

  async start(
    projectId: string,
    serviceId: string,
    ttlMs: number | undefined,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ port: ProjectPort; launchUrl: string }> {
    const project = await this.requireOwnedProject(projectId, actor.userId);
    await this.requireProjectService(projectId, serviceId);
    const result = await this.deps.previews.start(serviceId, ttlMs, actor);
    const [row] = await this.deps.db
      .select()
      .from(projectServices)
      .where(eq(projectServices.id, serviceId))
      .limit(1);
    if (!row) throw new ProjectPortNotFoundError('Project service not found.');
    return {
      port: {
        ...this.savedPort(row, project.nodeId),
        status: 'forwarding',
        forward: result.forward,
      },
      launchUrl: result.launchUrl,
    };
  }

  async stop(
    projectId: string,
    serviceId: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<void> {
    await this.requireOwnedProject(projectId, actor.userId);
    await this.requireProjectService(projectId, serviceId);
    await this.deps.previews.revoke(serviceId, actor);
  }

  async relaunch(
    projectId: string,
    serviceId: string,
    actor: { userId: string; ip?: string | null },
  ): Promise<{ port: ProjectPort; launchUrl: string }> {
    const project = await this.requireOwnedProject(projectId, actor.userId);
    await this.requireProjectService(projectId, serviceId);
    const result = await this.deps.previews.relaunch(serviceId, actor);
    const [row] = await this.deps.db
      .select()
      .from(projectServices)
      .where(eq(projectServices.id, serviceId))
      .limit(1);
    if (!row) throw new ProjectPortNotFoundError('Project service not found.');
    return {
      port: {
        ...this.savedPort(row, project.nodeId),
        status: 'forwarding',
        forward: result.forward,
      },
      launchUrl: result.launchUrl,
    };
  }

  private async discovery(nodeId: string, refresh: boolean): Promise<ListenerDiscoverySnapshot> {
    const cached = this.discoveryCache.get(nodeId);
    if (!refresh && cached && this.now() - cached.at < this.discoveryTtlMs) return cached.value;
    const pending = this.discoveryPending.get(nodeId);
    if (pending) return pending;
    const request = this.deps
      .discover(nodeId)
      .catch((error) => ({
        supported: true,
        healthy: false,
        reason: error instanceof Error ? error.message.slice(0, 512) : 'Listener discovery failed.',
        observedAt: null,
        ports: [],
      }))
      .then((value) => {
        if (this.discoveryCache.size >= 1_000 && !this.discoveryCache.has(nodeId)) {
          const oldest = this.discoveryCache.keys().next().value;
          if (oldest) this.discoveryCache.delete(oldest);
        }
        this.discoveryCache.set(nodeId, { at: this.now(), value });
        return value;
      })
      .finally(() => this.discoveryPending.delete(nodeId));
    this.discoveryPending.set(nodeId, request);
    return request;
  }

  private async requireOwnedProject(projectId: string, userId: string) {
    const [project] = await this.deps.db
      .select({
        id: projects.id,
        nodeId: projects.nodeId,
        workingDir: projects.workingDir,
        owner: nodes.createdBy,
      })
      .from(projects)
      .innerJoin(nodes, eq(nodes.id, projects.nodeId))
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new ProjectNotFoundError('Project not found.');
    if (project.owner && project.owner !== userId) {
      throw new PreviewForbiddenError('Project access denied.');
    }
    return project;
  }

  private async requireProjectService(projectId: string, serviceId: string): Promise<void> {
    const [service] = await this.deps.db
      .select({ id: projectServices.id })
      .from(projectServices)
      .where(and(eq(projectServices.id, serviceId), eq(projectServices.projectId, projectId)))
      .limit(1);
    if (!service) throw new PreviewServiceNotFoundError('Project service not found.');
  }

  private savedPort(row: typeof projectServices.$inferSelect, nodeId: string): ProjectPort {
    const forward = this.deps.previews.activeForService(row.id);
    return {
      id: row.id,
      serviceId: row.id,
      projectId: row.projectId,
      nodeId,
      targetHost: row.targetHost as '127.0.0.1' | '::1',
      targetPort: row.targetPort,
      protocol: row.protocol as ProjectPortProtocol,
      label: row.label,
      source: 'saved',
      process: null,
      remembered: true,
      autoForward: row.autoForward,
      status: forward ? 'forwarding' : 'stopped',
      lastSeenAt: null,
      forward,
    };
  }
}

function portKey(host: string, port: number, protocol: ProjectPortProtocol): string {
  return `${host}:${port}:${protocol}`;
}

function isWithinWorkingDirectory(candidate: string | undefined, workingDir: string): boolean {
  if (!candidate) return false;
  const root = workingDir.replace(/\/+$/, '') || '/';
  return candidate === root || (root !== '/' && candidate.startsWith(`${root}/`));
}

function inferredLabel(process: string | undefined, port: number): string {
  const name = process?.trim();
  if (name) return `${name.slice(0, 60)} · ${port}`;
  const conventional: Record<number, string> = {
    3000: 'Web',
    4173: 'Preview',
    5173: 'Vite',
    6006: 'Storybook',
    8000: 'Web',
    8080: 'API',
  };
  return `${conventional[port] ?? 'Service'} · ${port}`;
}

function compactProcess(listener: AgentdListeningPort): { pid?: number; name?: string } | null {
  const value = { pid: listener.pid, name: listener.process };
  return value.pid || value.name ? value : null;
}

export function associateProjectListeners(
  listeners: readonly AgentdListeningPort[],
  projectId: string,
  nodeProjects: readonly { id: string; workingDir: string }[],
  sessions: readonly { id: string; projectId: string }[],
): { assigned: AgentdListeningPort[]; unassignedCount: number; ambiguousCount: number } {
  const sessionProjects = new Map(sessions.map((session) => [session.id, session.projectId]));
  const assigned: AgentdListeningPort[] = [];
  let unassignedCount = 0;
  let ambiguousCount = 0;
  for (const listener of listeners) {
    const sessionProject = listener.sessionId ? sessionProjects.get(listener.sessionId) : undefined;
    if (sessionProject) {
      if (sessionProject === projectId) assigned.push(listener);
      continue;
    }
    const matches = nodeProjects.filter((candidate) =>
      isWithinWorkingDirectory(listener.cwd, candidate.workingDir),
    );
    if (matches.length === 0) unassignedCount += 1;
    else if (matches.length > 1) ambiguousCount += 1;
    else if (matches[0]!.id === projectId) assigned.push(listener);
  }
  return { assigned, unassignedCount, ambiguousCount };
}
