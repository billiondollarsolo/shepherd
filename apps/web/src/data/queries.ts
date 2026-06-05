/**
 * TanStack Query hooks for the paddock's server data (nodes/projects/sessions).
 *
 * Replaces the hand-rolled fetch+refresh logic that used to live in the zustand
 * store: Query owns caching, loading/error, dedup, and cache invalidation after
 * mutations. The store is now UI-only (selection + which dialog is open).
 *
 * Convention: one flat query per collection. Mutations invalidate the affected
 * collections so the tree refetches automatically; they also toast + return the
 * created entity so callers can react (e.g. select a new session).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CreateNodeRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  Event as FlockEvent,
  GitStatusResponse,
  Node as FlockNode,
  Project,
  Session,
  SessionPlan,
  UpdateNodeRequest,
} from '@flock/shared';
import {
  commitGit,
  createNode,
  updateNode,
  createProject,
  createSession,
  deleteNode,
  getGitStatus,
  getSessionPlan,
  listNodeDir,
  listNodes,
  listProjects,
  listSessionEvents,
  listSessions,
  pushGit,
  stageGitFiles,
  terminateSession,
  unstageGitFiles,
  updateSession,
} from './treeApi';
import type { UpdateSessionRequest } from '@flock/shared';
import type {
  ListNodeDirResponse,
  NodeFileReadResponse,
  NodeFsTreeResponse,
} from '@flock/shared';
import { getNodeFsTree, makeNodeDir, readNodeFile, writeNodeFile } from './treeApi';
import { getAgentdStatus, type AgentdHealth } from './treeApi';
import { getNodeStack, type NodeStack } from './treeApi';
import { getNodeInfo } from './treeApi';
import type { NodeInfo } from '@flock/shared';
import { ApiError } from '../routes/api';
import { toast } from '../components/ui/sonner';

/** Stable query keys (one namespace per collection). */
export const qk = {
  nodes: ['nodes'] as const,
  projects: ['projects'] as const,
  sessions: ['sessions'] as const,
  events: (sessionId: string) => ['events', sessionId] as const,
  gitStatus: (sessionId: string) => ['git-status', sessionId] as const,
  plan: (sessionId: string) => ['plan', sessionId] as const,
  fsTree: (nodeId: string, path: string) => ['fs-tree', nodeId, path] as const,
  fsFile: (nodeId: string, path: string) => ['fs-file', nodeId, path] as const,
  agentdStatus: ['agentd-status'] as const,
  stack: (nodeId: string, path: string) => ['stack', nodeId, path] as const,
};

function errMessage(e: unknown, fallback: string): string {
  // ApiError extends Error, so the Error branch already covers it.
  return e instanceof Error ? e.message : fallback;
}

// --- queries ---------------------------------------------------------------

export function useNodes(): UseQueryResult<FlockNode[]> {
  return useQuery({
    queryKey: qk.nodes,
    queryFn: async () => (await listNodes()).nodes,
  });
}

export function useProjects(): UseQueryResult<Project[]> {
  return useQuery({
    queryKey: qk.projects,
    queryFn: async () => (await listProjects()).projects,
  });
}

export function useSessions(): UseQueryResult<Session[]> {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: async () => (await listSessions()).sessions,
    // Live STATUS comes over the status WS (useLiveStatuses overrides the row's
    // status field), so this poll is only a SLOW backstop for lifecycle the WS
    // doesn't carry — sessions created/closed out-of-band (another client, daemon
    // reconcile). Same-client create/terminate invalidates this immediately.
    refetchInterval: 30_000,
  });
}

/**
 * flock-agentd connection health (the paddock "connected & communicating" dots).
 * Polled on a short interval, like sessions, so the dots track reality. Returns a
 * disabled snapshot when the daemon path is off (no dots shown).
 */
export function useAgentdStatus(): UseQueryResult<AgentdHealth> {
  return useQuery({
    queryKey: qk.agentdStatus,
    queryFn: () => getAgentdStatus(),
    // Per-session telemetry (tokens/tool/model/context%/cost) now arrives LIVE on
    // the status WS and is written into this cache (see LiveDataProvider). This
    // poll is a SLOW backstop only for what the WS doesn't carry: per-node daemon
    // link health + the precise daemon-list `live` flag, plus reconnect reconcile.
    refetchInterval: 30_000,
  });
}

/** Detected tech stacks for a project dir (badges + gitRepo). Rarely changes → long stale. */
export function useStack(
  nodeId: string,
  path: string,
  enabled = true,
): UseQueryResult<NodeStack> {
  return useQuery({
    queryKey: qk.stack(nodeId, path),
    enabled: enabled && nodeId !== '' && path !== '',
    queryFn: () => getNodeStack(nodeId, path),
    staleTime: 5 * 60_000,
    retry: false, // a non-git / unreachable dir just shows no badges
  });
}

/** The Activity timeline's events for one session (cold path; polled). */
export function useSessionEvents(sessionId: string | null): UseQueryResult<FlockEvent[]> {
  return useQuery({
    queryKey: qk.events(sessionId ?? ''),
    enabled: sessionId != null,
    queryFn: async () => (sessionId ? (await listSessionEvents(sessionId)).events : []),
    refetchInterval: 5_000,
  });
}

/** The agent's latest plan/todo snapshot for the Activity Plan artifact (polled). */
export function useSessionPlan(sessionId: string | null): UseQueryResult<SessionPlan | null> {
  return useQuery({
    queryKey: qk.plan(sessionId ?? ''),
    enabled: sessionId != null,
    queryFn: async () => (sessionId ? (await getSessionPlan(sessionId)).plan : null),
    refetchInterval: 5_000,
  });
}

/**
 * Browse directories on a node (the path picker). Keyed by node + path so each
 * directory level is cached; `enabled` lets the caller defer until a node is
 * chosen. `path === undefined` lists the node's home dir. Returns null entries
 * gracefully via the query error state (the UI shows the reason).
 */
export function useNodeDir(
  nodeId: string | undefined,
  path: string | undefined,
  enabled = true,
): UseQueryResult<ListNodeDirResponse> {
  return useQuery({
    queryKey: ['node-fs', nodeId, path ?? '~'] as const,
    queryFn: () => listNodeDir(nodeId as string, path),
    enabled: enabled && !!nodeId,
    retry: false,
    staleTime: 10_000,
  });
}

/**
 * The Source Control panel's git status (file list + branch/ahead/behind) for a
 * session. Cold path; polled while the panel is open so the list stays current
 * as the agent edits files. `enabled` defers until a session is selected.
 */
export function useGitStatus(
  sessionId: string | null,
): UseQueryResult<GitStatusResponse | null> {
  return useQuery({
    queryKey: qk.gitStatus(sessionId ?? ''),
    enabled: sessionId != null,
    // A non-git working dir returns 422 (git_unavailable). Treat that as a normal
    // "not a repo" result (`null`) instead of an error, so it's probed ONCE and
    // cached — never refetched on remount/tab-switch (the source of the 422 spam).
    // Real errors still throw and surface.
    queryFn: async () => {
      try {
        return await getGitStatus(sessionId as string);
      } catch (err) {
        if (err instanceof ApiError && err.status === 422) return null;
        throw err;
      }
    },
    // Cache the verdict; only POLL when it IS a repo (data != null). For a non-repo
    // the data is `null` and `refetchInterval` returns false → no polling at all.
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.data == null ? false : 5_000),
    retry: false,
  });
}

/** Live host metrics + detected agents for a node (node-info dialog + bottom bar). */
export function useNodeInfo(nodeId: string | null): UseQueryResult<NodeInfo> {
  return useQuery({
    queryKey: ['node-info', nodeId ?? ''],
    enabled: nodeId != null,
    queryFn: () => getNodeInfo(nodeId as string),
    refetchInterval: 4000,
    retry: false,
  });
}

/** One level of a node's file tree (dirs + files). Lazy: enabled when expanded. */
export function useNodeFsTree(
  nodeId: string | null,
  path: string | null,
  enabled = true,
): UseQueryResult<NodeFsTreeResponse> {
  return useQuery({
    queryKey: qk.fsTree(nodeId ?? '', path ?? ''),
    enabled: enabled && nodeId != null && path != null,
    queryFn: () => getNodeFsTree(nodeId as string, path as string),
    staleTime: 5_000,
    retry: false,
  });
}

/** Read a single file's bytes (base64). Enabled when a file is selected. */
export function useNodeFile(
  nodeId: string | null,
  path: string | null,
): UseQueryResult<NodeFileReadResponse> {
  return useQuery({
    queryKey: qk.fsFile(nodeId ?? '', path ?? ''),
    enabled: nodeId != null && path != null,
    queryFn: () => readNodeFile(nodeId as string, path as string),
    retry: false,
  });
}

/** Write a file (editor save / upload); refreshes its cached read on success. */
export function useWriteNodeFile(nodeId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, contentBase64 }: { path: string; contentBase64: string }) =>
      writeNodeFile(nodeId as string, path, contentBase64),
    onSuccess: (_res, { path }) => {
      if (nodeId) void qc.invalidateQueries({ queryKey: qk.fsFile(nodeId, path) });
    },
    onError: (e) => toast.error(errMessage(e, 'Could not save file')),
  });
}

/** Create a directory on a node (path picker "New folder"). Refreshes the node's
 *  dir listings so the new folder appears. */
export function useMakeNodeDir(nodeId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parent, name }: { parent: string; name: string }) =>
      makeNodeDir(nodeId as string, parent, name),
    onSuccess: () => {
      // Prefix-invalidate every ['node-fs', nodeId, *] listing so the picker shows it.
      if (nodeId) void qc.invalidateQueries({ queryKey: ['node-fs', nodeId] });
    },
    onError: (e) => toast.error(errMessage(e, 'Could not create folder')),
  });
}

// --- mutations -------------------------------------------------------------

export function useCreateNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNodeRequest) => createNode(input),
    onSuccess: ({ node }) => {
      void qc.invalidateQueries({ queryKey: qk.nodes });
      toast.success(`Node “${node.name}” added`);
    },
    onError: (e) => toast.error(errMessage(e, 'Could not add node')),
  });
}

export function useUpdateNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateNodeRequest }) => updateNode(id, input),
    onSuccess: ({ node }) => {
      void qc.invalidateQueries({ queryKey: qk.nodes });
      toast.success(`Node “${node.name}” updated`);
    },
    onError: (e) => toast.error(errMessage(e, 'Could not update node')),
  });
}
export function useDeleteNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteNode(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.nodes });
      void qc.invalidateQueries({ queryKey: qk.projects });
      void qc.invalidateQueries({ queryKey: qk.sessions });
      toast.success('Node removed');
    },
    onError: (e) => toast.error(errMessage(e, 'Could not remove node')),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectRequest) => createProject(input),
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: qk.projects });
      toast.success(`Project “${project.name}” added`);
    },
    onError: (e) => toast.error(errMessage(e, 'Could not add project')),
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionRequest) => createSession(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sessions });
      toast.success('Session started');
    },
    onError: (e) => toast.error(errMessage(e, 'Could not start session')),
  });
}

export function useTerminateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => terminateSession(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sessions });
      toast.success('Session terminated');
    },
    onError: (e) => toast.error(errMessage(e, 'Could not terminate session')),
  });
}
/** Update a session's pin / note (cosmetic supervisor metadata). */
export function useUpdateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSessionRequest }) =>
      updateSession(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sessions });
    },
    onError: (e) => toast.error(errMessage(e, 'Could not update session')),
  });
}

// --- git source control (US-33.1) ------------------------------------------

/** Stage/unstage write fresh status into the cache so the panel updates at once. */
function gitStatusWriter(qc: ReturnType<typeof useQueryClient>, sessionId: string) {
  return (status: GitStatusResponse) => qc.setQueryData(qk.gitStatus(sessionId), status);
}

export function useStageFiles(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => stageGitFiles(sessionId, paths),
    onSuccess: gitStatusWriter(qc, sessionId),
    onError: (e) => toast.error(errMessage(e, 'Could not stage')),
  });
}

export function useUnstageFiles(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => unstageGitFiles(sessionId, paths),
    onSuccess: gitStatusWriter(qc, sessionId),
    onError: (e) => toast.error(errMessage(e, 'Could not unstage')),
  });
}

export function useCommit(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => commitGit(sessionId, message),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.gitStatus(sessionId) });
      if (res.committed) toast.success(res.sha ? `Committed ${res.sha}` : 'Committed');
      else toast.message(res.detail);
    },
    onError: (e) => toast.error(errMessage(e, 'Could not commit')),
  });
}

export function usePush(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pushGit(sessionId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.gitStatus(sessionId) });
      toast.success('Pushed');
      return res;
    },
    onError: (e) => toast.error(errMessage(e, 'Push failed')),
  });
}
