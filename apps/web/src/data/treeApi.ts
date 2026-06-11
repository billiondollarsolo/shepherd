/**
 * Tree CRUD API client — nodes, projects, sessions (the paddock's data plane).
 *
 * Mirrors the auth client in `../routes/api.ts`: same-origin by default
 * (`VITE_API_URL` empty), cookies included, shared zod contract types from
 * `@flock/shared` (never duplicated). Used by the zustand paddock store.
 */
import type {
  CreateNodeRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  Event,
  GitCommitResponse,
  GitPushResponse,
  GitStatusResponse,
  GitBranchesResponse,
  GitBranchResponse,
  GitPrResponse,
  ListNodeDirResponse,
  ListNodesResponse,
  ListProjectsResponse,
  ListSessionsResponse,
  Node as FlockNode,
  NodeInfo,
  NodeFileReadResponse,
  NodeFileWriteResponse,
  NodeMakeDirResponse,
  NodeFsTreeResponse,
  Project,
  ProjectResponse,
  NodeResponse,
  NodeEnvResponse,
  SessionResponse,
  UpdateSessionRequest,
  UpdateNodeRequest,
  SessionPlanResponse,
} from '@flock/shared';
import { ApiError } from '../routes/api';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON content-type when we actually send a body. Sending
  // `content-type: application/json` with an EMPTY body (e.g. DELETE/GET) makes
  // Fastify reject the request with 400 FST_ERR_CTP_EMPTY_JSON_BODY before the
  // route runs (this was the "DELETE session -> 400" bug).
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body != null && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (body.error ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

// --- workspace intelligence (stack detection, fuzzy files, Find-in-Files) ---
export interface NodeStack {
  path: string;
  stacks: string[];
  /** True when the dir is a git work tree. */
  gitRepo: boolean;
  /** True when HEAD resolves (≥1 commit). The worktree toggle gates on THIS — a
   *  freshly `git init`'d repo with no commits can't create a worktree. */
  gitHasCommits: boolean;
}
export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}
export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}
export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}
export function getNodeStack(nodeId: string, path: string): Promise<NodeStack> {
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/stack?path=${encodeURIComponent(path)}`);
}
export function listNodeFiles(nodeId: string, path: string): Promise<{ files: string[] }> {
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/files?path=${encodeURIComponent(path)}`);
}
export function searchNode(
  nodeId: string,
  path: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/search`, {
    method: 'POST',
    body: JSON.stringify({ path, query, ...opts }),
  });
}

// --- flock-agentd connection health (the paddock "connected" dots) ---
/** Per-node daemon link + per-session liveness from GET /api/agentd/status. */
export interface AgentdHealth {
  enabled: boolean;
  /** Keyed by nodeId — whether the multiplexed daemon link is live. */
  nodes: Record<string, { link: 'up' | 'down' }>;
  /**
   * Keyed by sessionId — whether the session's PTY is running on the daemon, plus
   * derived telemetry from the agent's transcript: cumulative tokens, current tool,
   * model name, context-window % (T19), and an estimated $ cost (T19).
   */
  sessions: Record<
    string,
    {
      live: boolean;
      tokens?: number;
      tool?: string;
      model?: string;
      contextPct?: number;
      contextTokens?: number;
      contextLimit?: number;
      costUsd?: number;
    }
  >;
}
export function getAgentdStatus(): Promise<AgentdHealth> {
  return request('/api/agentd/status');
}

/** GET /api/nodes/:id/info — live host metrics + detected agents for one node. */
export function getNodeInfo(nodeId: string): Promise<NodeInfo> {
  return request(`/api/nodes/${nodeId}/info`);
}

// --- nodes ---
export function listNodes(): Promise<ListNodesResponse> {
  return request('/api/nodes');
}
export function createNode(input: CreateNodeRequest): Promise<NodeResponse> {
  return request('/api/nodes', { method: 'POST', body: JSON.stringify(input) });
}
export function updateNode(id: string, input: UpdateNodeRequest): Promise<NodeResponse> {
  return request(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}
export function getNodeEnv(id: string): Promise<NodeEnvResponse> {
  return request(`/api/nodes/${id}/env`);
}
export function deleteNode(id: string): Promise<void> {
  return request(`/api/nodes/${id}`, { method: 'DELETE' });
}

/** List directories on a node (path picker). Omit `path` to start at $HOME. */
export function listNodeDir(nodeId: string, path?: string): Promise<ListNodeDirResponse> {
  const q = path !== undefined ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/fs${q}`);
}

// --- node file browser (dirs + files, read/write) ---
export function getNodeFsTree(nodeId: string, path?: string): Promise<NodeFsTreeResponse> {
  const q = path !== undefined ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/fs/tree${q}`);
}
export function readNodeFile(nodeId: string, path: string): Promise<NodeFileReadResponse> {
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/fs/file?path=${encodeURIComponent(path)}`);
}
export function writeNodeFile(
  nodeId: string,
  path: string,
  contentBase64: string,
): Promise<NodeFileWriteResponse> {
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/fs/file`, {
    method: 'PUT',
    body: JSON.stringify({ path, contentBase64 }),
  });
}
/** Create a new directory `name` inside `parent` (path picker "New folder"). */
export function makeNodeDir(
  nodeId: string,
  parent: string,
  name: string,
): Promise<NodeMakeDirResponse> {
  return request(`/api/nodes/${encodeURIComponent(nodeId)}/fs/mkdir`, {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
  });
}

// --- projects ---
export function listProjects(nodeId?: string): Promise<ListProjectsResponse> {
  const q = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
  return request(`/api/projects${q}`);
}
export function createProject(input: CreateProjectRequest): Promise<ProjectResponse> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(input) });
}

// --- sessions ---
export function listSessions(projectId?: string): Promise<ListSessionsResponse> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request(`/api/sessions${q}`);
}
export function createSession(input: CreateSessionRequest): Promise<CreateSessionResponse> {
  return request('/api/sessions', { method: 'POST', body: JSON.stringify(input) });
}
export function terminateSession(id: string): Promise<void> {
  return request(`/api/sessions/${id}`, { method: 'DELETE' });
}
export function updateSession(id: string, patch: UpdateSessionRequest): Promise<SessionResponse> {
  return request(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
/** Kill a split-pane shell PTY (`<sessionId>:shell[-N]`) on the daemon. */
export function terminatePtyPane(ptyId: string): Promise<void> {
  return request(`/api/pty/${encodeURIComponent(ptyId)}`, { method: 'DELETE' });
}
export function listSessionEvents(id: string): Promise<{ events: Event[] }> {
  return request(`/api/sessions/${id}/events`);
}
/** Fleet-wide recent activity (cross-agent audit timeline). */
export function listFleetActivity(limit = 60): Promise<{ events: Event[] }> {
  return request(`/api/activity/fleet?limit=${limit}`);
}
export function getLatestChats(): Promise<{ chats: Record<string, { role: string; text: string }> }> {
  return request('/api/chats/latest');
}
export function getTeams(): Promise<{ edges: Array<{ parent: string; child: string }> }> {
  return request('/api/teams');
}

// --- config-as-code (flock.yml) ---
export interface ConfigApplySummary {
  projectsCreated: string[];
  sessionsCreated: string[];
  warnings: string[];
}
export function applyConfig(yaml: string): Promise<ConfigApplySummary> {
  return request('/api/config/apply', { method: 'POST', body: JSON.stringify({ yaml }) });
}
export function exportConfig(): Promise<{ yaml: string }> {
  return request('/api/config/export');
}
/** Hand a session's task + recent context to a fresh agent (any type) in the same
 *  project/cwd. Returns the new session. */
export function handoffSession(id: string, agentType: string): Promise<{ session: { id: string } }> {
  return request(`/api/sessions/${id}/handoff`, { method: 'POST', body: JSON.stringify({ agentType }) });
}

// --- compare / race ---
/** Spawn the same task across N agents (each in its own worktree), seeded with the
 *  task. Returns the racer session ids to compare. */
export function startRace(
  projectId: string,
  task: string,
  agentTypes: string[],
): Promise<{ task: string; sessionIds: string[] }> {
  return request('/api/race', { method: 'POST', body: JSON.stringify({ projectId, task, agentTypes }) });
}
export function getSessionPlan(id: string): Promise<SessionPlanResponse> {
  return request(`/api/sessions/${id}/plan`);
}

// --- git source control (US-33.1) ---
export function getGitStatus(id: string): Promise<GitStatusResponse> {
  return request(`/api/sessions/${id}/git/status`);
}
export function stageGitFiles(id: string, paths: string[]): Promise<GitStatusResponse> {
  return request(`/api/sessions/${id}/git/stage`, { method: 'POST', body: JSON.stringify({ paths }) });
}
export function unstageGitFiles(id: string, paths: string[]): Promise<GitStatusResponse> {
  return request(`/api/sessions/${id}/git/unstage`, {
    method: 'POST',
    body: JSON.stringify({ paths }),
  });
}
export function commitGit(id: string, message: string): Promise<GitCommitResponse> {
  return request(`/api/sessions/${id}/git/commit`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}
export function pushGit(id: string): Promise<GitPushResponse> {
  // No body: a JSON content-type with an empty body would 400 in Fastify.
  return request(`/api/sessions/${id}/git/push`, { method: 'POST' });
}
export function branchesGit(id: string): Promise<GitBranchesResponse> {
  return request(`/api/sessions/${id}/git/branches`);
}
export function createBranchGit(id: string, name: string, from?: string): Promise<GitBranchResponse> {
  return request(`/api/sessions/${id}/git/branch`, {
    method: 'POST',
    body: JSON.stringify({ name, from }),
  });
}
export function createPrGit(
  id: string,
  input: { title: string; body?: string; base?: string; draft?: boolean },
): Promise<GitPrResponse> {
  return request(`/api/sessions/${id}/git/pr`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type { FlockNode, Project };
