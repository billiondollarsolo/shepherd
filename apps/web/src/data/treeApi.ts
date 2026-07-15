/**
 * Tree CRUD API client — nodes, projects, sessions (the paddock's data plane).
 *
 * Mirrors the auth client in `../routes/api.ts`: same-origin by default
 * (`VITE_API_URL` empty), cookies included, shared zod contract types from
 * `@flock/shared` (never duplicated). Used by the zustand paddock store.
 */
import {
  CreateSessionResponse as CreateSessionResponseSchema,
  EventSchema,
  GitBranchResponse as GitBranchResponseSchema,
  GitCommitResponse as GitCommitResponseSchema,
  GitPrResponse as GitPrResponseSchema,
  GitPushResponse as GitPushResponseSchema,
  GitStatusResponse as GitStatusResponseSchema,
  ListNodeDirResponse as ListNodeDirResponseSchema,
  ListNodesResponse as ListNodesResponseSchema,
  ListProjectsResponse as ListProjectsResponseSchema,
  ListSessionsResponse as ListSessionsResponseSchema,
  NodeEnvResponse as NodeEnvResponseSchema,
  NodeFileReadResponse as NodeFileReadResponseSchema,
  NodeFileWriteResponse as NodeFileWriteResponseSchema,
  NodeFsTreeResponse as NodeFsTreeResponseSchema,
  NodeInfoSchema,
  NodePreflightResponseSchema,
  NodeMakeDirResponse as NodeMakeDirResponseSchema,
  NodeResponse as NodeResponseSchema,
  ProjectResponse as ProjectResponseSchema,
  ListProjectPortsResponse as ListProjectPortsResponseSchema,
  ProjectPortResponse as ProjectPortResponseSchema,
  StartProjectForwardResponse as StartProjectForwardResponseSchema,
  DeploymentPreviewSettingsResponse as DeploymentPreviewSettingsResponseSchema,
  PreviewRoutingTestResponse as PreviewRoutingTestResponseSchema,
  SessionPlanResponse as SessionPlanResponseSchema,
  SessionResponse as SessionResponseSchema,
  TerminateSessionResponse as TerminateSessionResponseSchema,
  type CreateNodeRequest,
  type CreateProjectRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type Event,
  type GitCommitResponse,
  type GitPushResponse,
  type GitStatusResponse,
  type GitBranchResponse,
  type GitPrResponse,
  type ListNodeDirResponse,
  type ListNodesResponse,
  type ListProjectsResponse,
  type ListSessionsResponse,
  type Node as FlockNode,
  type NodeInfo,
  type NodePreflightResponse,
  type NodeFileReadResponse,
  type NodeFileWriteResponse,
  type NodeMakeDirResponse,
  type NodeFsTreeResponse,
  type Project,
  type ProjectResponse,
  type ListProjectPortsResponse,
  type ProjectPortResponse,
  type StartProjectForwardResponse,
  type DeploymentPreviewSettingsResponse,
  type PreviewRoutingTestResponse,
  type SaveProjectPortRequest,
  type UpdateProjectPortRequest,
  type UpdatePreviewRuntimeSettingsRequest,
  type NodeResponse,
  type NodeEnvResponse,
  type SessionResponse,
  type TerminateSessionResponse,
  type UpdateSessionRequest,
  type UpdateNodeRequest,
  type UpdateProjectAgentPolicyRequest,
  type SessionPlanResponse,
} from '@flock/shared';
import { z } from 'zod';
import { apiRequest } from '../lib/apiClient';

// --- workspace intelligence (stack detection, fuzzy files, Find-in-Files) ---
const NodeStackSchema = z.object({
  path: z.string(),
  stacks: z.array(z.string()),
  gitRepo: z.boolean(),
  gitHasCommits: z.boolean(),
});
export type NodeStack = z.infer<typeof NodeStackSchema>;
const SearchResultSchema = z.object({
  matches: z.array(z.object({ file: z.string(), line: z.number().int(), text: z.string() })),
  truncated: z.boolean(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchMatch = SearchResult['matches'][number];
export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}
export function getNodeStack(nodeId: string, path: string): Promise<NodeStack> {
  return apiRequest(
    `/api/nodes/${encodeURIComponent(nodeId)}/stack?path=${encodeURIComponent(path)}`,
    { schema: NodeStackSchema },
  );
}
export function searchNode(
  nodeId: string,
  path: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  return apiRequest(`/api/nodes/${encodeURIComponent(nodeId)}/search`, {
    method: 'POST',
    body: JSON.stringify({ path, query, ...opts }),
    schema: SearchResultSchema,
  });
}

// --- flock-agentd connection health (the paddock "connected" dots) ---
/** Per-node daemon link + per-session liveness from GET /api/agentd/status. */
const AgentdHealthSchema = z.object({
  enabled: z.boolean(),
  nodes: z.record(
    z.object({
      link: z.enum(['up', 'down']),
      failure: z
        .object({
          code: z.enum(['network', 'authentication', 'protocol', 'enrollment']),
          message: z.string(),
          at: z.string(),
        })
        .optional(),
    }),
  ),
  sessions: z.record(
    z.object({
      live: z.boolean(),
      tokens: z.number().optional(),
      tool: z.string().optional(),
      model: z.string().optional(),
      contextPct: z.number().optional(),
      contextTokens: z.number().optional(),
      contextLimit: z.number().optional(),
      costUsd: z.number().optional(),
    }),
  ),
});
export type AgentdHealth = z.infer<typeof AgentdHealthSchema>;
export function getAgentdStatus(): Promise<AgentdHealth> {
  return apiRequest('/api/agentd/status', { schema: AgentdHealthSchema });
}

/** GET /api/nodes/:id/info — live host metrics + detected agents for one node. */
export function getNodeInfo(nodeId: string): Promise<NodeInfo> {
  return apiRequest(`/api/nodes/${nodeId}/info`, { schema: NodeInfoSchema });
}

/** GET /api/nodes/:id/preflight — read-only node preparation/readiness checks. */
export function getNodePreflight(nodeId: string): Promise<NodePreflightResponse> {
  return apiRequest(`/api/nodes/${nodeId}/preflight`, { schema: NodePreflightResponseSchema });
}

const UpgradeNodeAgentdResponseSchema = z.object({
  nodeId: z.string().uuid(),
  upgraded: z.literal(true),
});
export function upgradeNodeAgentd(nodeId: string): Promise<{ nodeId: string; upgraded: true }> {
  return apiRequest(`/api/nodes/${nodeId}/upgrade-agentd`, {
    method: 'POST',
    body: JSON.stringify({ confirm: 'UPGRADE' }),
    schema: UpgradeNodeAgentdResponseSchema,
  });
}

// --- nodes ---
export function listNodes(): Promise<ListNodesResponse> {
  return apiRequest('/api/nodes', { schema: ListNodesResponseSchema });
}
export function createNode(input: CreateNodeRequest): Promise<NodeResponse> {
  return apiRequest('/api/nodes', {
    method: 'POST',
    body: JSON.stringify(input),
    schema: NodeResponseSchema,
  });
}
export function updateNode(id: string, input: UpdateNodeRequest): Promise<NodeResponse> {
  return apiRequest(`/api/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    schema: NodeResponseSchema,
  });
}
export function getNodeEnv(id: string): Promise<NodeEnvResponse> {
  return apiRequest(`/api/nodes/${id}/env`, { schema: NodeEnvResponseSchema });
}
export function deleteNode(id: string): Promise<void> {
  return apiRequest(`/api/nodes/${id}`, { method: 'DELETE', response: 'void' });
}

/** List directories on a node (path picker). Omit `path` to start at $HOME. */
export function listNodeDir(nodeId: string, path?: string): Promise<ListNodeDirResponse> {
  const q = path !== undefined ? `?path=${encodeURIComponent(path)}` : '';
  return apiRequest(`/api/nodes/${encodeURIComponent(nodeId)}/fs${q}`, {
    schema: ListNodeDirResponseSchema,
  });
}

// --- node file browser (dirs + files, read/write) ---
export function getNodeFsTree(nodeId: string, path?: string): Promise<NodeFsTreeResponse> {
  const q = path !== undefined ? `?path=${encodeURIComponent(path)}` : '';
  return apiRequest(`/api/nodes/${encodeURIComponent(nodeId)}/fs/tree${q}`, {
    schema: NodeFsTreeResponseSchema,
  });
}
export function readNodeFile(nodeId: string, path: string): Promise<NodeFileReadResponse> {
  return apiRequest(
    `/api/nodes/${encodeURIComponent(nodeId)}/fs/file?path=${encodeURIComponent(path)}`,
    { schema: NodeFileReadResponseSchema },
  );
}
export function writeNodeFile(
  nodeId: string,
  path: string,
  contentBase64: string,
): Promise<NodeFileWriteResponse> {
  return apiRequest(`/api/nodes/${encodeURIComponent(nodeId)}/fs/file`, {
    method: 'PUT',
    body: JSON.stringify({ path, contentBase64 }),
    schema: NodeFileWriteResponseSchema,
  });
}
/** Create a new directory `name` inside `parent` (path picker "New folder"). */
export function makeNodeDir(
  nodeId: string,
  parent: string,
  name: string,
): Promise<NodeMakeDirResponse> {
  return apiRequest(`/api/nodes/${encodeURIComponent(nodeId)}/fs/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
    schema: NodeMakeDirResponseSchema,
  });
}

// --- projects ---
export function listProjects(nodeId?: string): Promise<ListProjectsResponse> {
  const q = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
  return apiRequest(`/api/projects${q}`, { schema: ListProjectsResponseSchema });
}
export function createProject(input: CreateProjectRequest): Promise<ProjectResponse> {
  return apiRequest('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
    schema: ProjectResponseSchema,
  });
}
export function updateProjectAgentPolicy(
  projectId: string,
  input: UpdateProjectAgentPolicyRequest,
): Promise<ProjectResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/agent-policy`, {
    method: 'PATCH',
    body: JSON.stringify(input),
    schema: ProjectResponseSchema,
  });
}

// --- sessions ---
export function listSessions(projectId?: string): Promise<ListSessionsResponse> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return apiRequest(`/api/sessions${q}`, { schema: ListSessionsResponseSchema });
}
export function createSession(input: CreateSessionRequest): Promise<CreateSessionResponse> {
  return apiRequest('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
    schema: CreateSessionResponseSchema,
  });
}
export function terminateSession(id: string): Promise<TerminateSessionResponse> {
  return apiRequest(`/api/sessions/${id}`, {
    method: 'DELETE',
    schema: TerminateSessionResponseSchema,
  });
}
export function updateSession(id: string, patch: UpdateSessionRequest): Promise<SessionResponse> {
  return apiRequest(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    schema: SessionResponseSchema,
  });
}
const EventsResponseSchema = z.object({ events: z.array(EventSchema) });
export function listSessionEvents(id: string): Promise<{ events: Event[] }> {
  return apiRequest(`/api/sessions/${id}/events`, { schema: EventsResponseSchema });
}
/** Fleet-wide recent activity (cross-agent audit timeline). */
export function listFleetActivity(limit = 60): Promise<{ events: Event[] }> {
  return apiRequest(`/api/activity/fleet?limit=${limit}`, { schema: EventsResponseSchema });
}

// --- config-as-code (flock.yml) ---
export interface ConfigApplySummary {
  projectsCreated: string[];
  sessionsCreated: string[];
  warnings: string[];
}
const ConfigApplySummarySchema: z.ZodType<ConfigApplySummary> = z.object({
  projectsCreated: z.array(z.string()),
  sessionsCreated: z.array(z.string()),
  warnings: z.array(z.string()),
});
export function applyConfig(yaml: string): Promise<ConfigApplySummary> {
  return apiRequest('/api/config/apply', {
    method: 'POST',
    body: JSON.stringify({ yaml }),
    schema: ConfigApplySummarySchema,
  });
}
export function exportConfig(): Promise<{ yaml: string }> {
  return apiRequest('/api/config/export', { schema: z.object({ yaml: z.string() }) });
}
/** Hand a session's task + recent context to a fresh agent (any type) in the same
 *  project/cwd. Returns the new session. */
export function handoffSession(
  id: string,
  agentType: string,
): Promise<{ session: { id: string } }> {
  return apiRequest(`/api/sessions/${id}/handoff`, {
    method: 'POST',
    body: JSON.stringify({ agentType }),
    schema: z.object({ session: z.object({ id: z.string() }) }),
  });
}

// --- compare / race ---
/** Spawn the same task across N agents in the project directory. Shepherd observes
 * Git state but does not create branches or worktrees. */
export function startRace(
  projectId: string,
  task: string,
  agentTypes: string[],
): Promise<{ task: string; sessionIds: string[] }> {
  return apiRequest('/api/race', {
    method: 'POST',
    body: JSON.stringify({ projectId, task, agentTypes }),
    schema: z.object({ task: z.string(), sessionIds: z.array(z.string()) }),
  });
}
export function getSessionPlan(id: string): Promise<SessionPlanResponse> {
  return apiRequest(`/api/sessions/${id}/plan`, { schema: SessionPlanResponseSchema });
}

// --- project-owned development ports and Preview --------------------------
export function listProjectPorts(projectId: string): Promise<ListProjectPortsResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/ports`, {
    schema: ListProjectPortsResponseSchema,
  });
}

export function refreshProjectPorts(projectId: string): Promise<ListProjectPortsResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/ports/refresh`, {
    method: 'POST',
    schema: ListProjectPortsResponseSchema,
  });
}

export function activateProjectPorts(projectId: string): Promise<void> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/ports/activate`, {
    method: 'POST',
    response: 'void',
  });
}

export function saveProjectPort(
  projectId: string,
  input: SaveProjectPortRequest,
): Promise<ProjectPortResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/ports`, {
    method: 'POST',
    body: JSON.stringify(input),
    schema: ProjectPortResponseSchema,
  });
}

export function updateProjectPort(
  projectId: string,
  serviceId: string,
  input: UpdateProjectPortRequest,
): Promise<ProjectPortResponse> {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/ports/${encodeURIComponent(serviceId)}`,
    { method: 'PATCH', body: JSON.stringify(input), schema: ProjectPortResponseSchema },
  );
}

export function forgetProjectPort(projectId: string, serviceId: string): Promise<void> {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/ports/${encodeURIComponent(serviceId)}`,
    { method: 'DELETE', response: 'void' },
  );
}

export function startProjectForward(
  projectId: string,
  serviceId: string,
  ttlMs?: number,
): Promise<StartProjectForwardResponse> {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/ports/${encodeURIComponent(serviceId)}/forward`,
    {
      method: 'POST',
      body: JSON.stringify(ttlMs === undefined ? {} : { ttlMs }),
      schema: StartProjectForwardResponseSchema,
    },
  );
}

export function relaunchProjectForward(
  projectId: string,
  serviceId: string,
): Promise<StartProjectForwardResponse> {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/ports/${encodeURIComponent(serviceId)}/forward/relaunch`,
    { method: 'POST', schema: StartProjectForwardResponseSchema },
  );
}

export function stopProjectForward(projectId: string, serviceId: string): Promise<void> {
  return apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/ports/${encodeURIComponent(serviceId)}/forward`,
    { method: 'DELETE', response: 'void' },
  );
}

export function getDeploymentPreviewSettings(): Promise<DeploymentPreviewSettingsResponse> {
  return apiRequest('/api/settings/deployment-preview', {
    schema: DeploymentPreviewSettingsResponseSchema,
  });
}

export function updateDeploymentPreviewSettings(
  input: UpdatePreviewRuntimeSettingsRequest,
): Promise<DeploymentPreviewSettingsResponse> {
  return apiRequest('/api/settings/deployment-preview', {
    method: 'PATCH',
    body: JSON.stringify(input),
    schema: DeploymentPreviewSettingsResponseSchema,
  });
}

export function testDeploymentPreviewRouting(): Promise<PreviewRoutingTestResponse> {
  return apiRequest('/api/settings/deployment-preview/test', {
    method: 'POST',
    schema: PreviewRoutingTestResponseSchema,
  });
}

// --- git source control (US-33.1) ---
export function getGitStatus(id: string): Promise<GitStatusResponse> {
  return apiRequest(`/api/sessions/${id}/git/status`, { schema: GitStatusResponseSchema });
}
export function stageGitFiles(id: string, paths: string[]): Promise<GitStatusResponse> {
  return apiRequest(`/api/sessions/${id}/git/stage`, {
    method: 'POST',
    body: JSON.stringify({ paths }),
    schema: GitStatusResponseSchema,
  });
}
export function unstageGitFiles(id: string, paths: string[]): Promise<GitStatusResponse> {
  return apiRequest(`/api/sessions/${id}/git/unstage`, {
    method: 'POST',
    body: JSON.stringify({ paths }),
    schema: GitStatusResponseSchema,
  });
}
export function commitGit(id: string, message: string): Promise<GitCommitResponse> {
  return apiRequest(`/api/sessions/${id}/git/commit`, {
    method: 'POST',
    body: JSON.stringify({ message }),
    schema: GitCommitResponseSchema,
  });
}
export function pushGit(id: string): Promise<GitPushResponse> {
  // No body: a JSON content-type with an empty body would 400 in Fastify.
  return apiRequest(`/api/sessions/${id}/git/push`, {
    method: 'POST',
    schema: GitPushResponseSchema,
  });
}
export function createBranchGit(
  id: string,
  name: string,
  from?: string,
): Promise<GitBranchResponse> {
  return apiRequest(`/api/sessions/${id}/git/branch`, {
    method: 'POST',
    body: JSON.stringify({ name, from }),
    schema: GitBranchResponseSchema,
  });
}
export function createPrGit(
  id: string,
  input: { title: string; body?: string; base?: string; draft?: boolean },
): Promise<GitPrResponse> {
  return apiRequest(`/api/sessions/${id}/git/pr`, {
    method: 'POST',
    body: JSON.stringify(input),
    schema: GitPrResponseSchema,
  });
}

export type { FlockNode, Project };
