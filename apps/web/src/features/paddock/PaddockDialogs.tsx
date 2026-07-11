/**
 * The paddock's create dialogs — Add Node, Add Project, Add Session — driven by
 * the zustand store's `dialog` state. Rendered once near the shell root.
 */
import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HardDrive, FolderGit2, Bot, FolderOpen, TriangleAlert } from 'lucide-react';
import type { AgentType, NodeKind, SessionPermissionMode, SshAuthMethod } from '@flock/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '../../components/ui';
import { usePaddock } from '../../store/paddock';
import {
  useCreateNode,
  useUpdateNode,
  useCreateProject,
  useCreateSession,
  useNodeInfo,
  useNodes,
  useProjects,
  useSessions,
  useTerminateSession,
} from '../../data/queries';
import {
  applyConfig,
  exportConfig,
  getNodeEnv,
  startRace,
  type ConfigApplySummary,
} from '../../data/treeApi';
import { fetchLauncherPresets } from '../shell/launcherPresetsApi';
import type { LauncherPreset } from '@flock/shared';
import { pickBestNode } from './placement';
import { PathBrowser } from './PathBrowser';

const AGENT_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  grok: 'Grok',
  aider: 'Aider',
  'cursor-agent': 'Cursor Agent',
  amp: 'Amp',
  generic: 'Generic (OSC/PTY)',
  terminal: 'Terminal (plain shell)',
  dev: 'Dev server (auto-restart)',
};

/**
 * The CLI binary each agent needs ON THE NODE, or null for agents that need none
 * (a bare shell). Used to grey out agents whose CLI the node's flock-agentd hasn't
 * detected (NodeInfo.agents) — so you can't pick one that would fail at launch
 * with "executable not found". Keys mirror the agent-launch `command[0]` binaries.
 */
const REQUIRED_BIN: Record<AgentType, string | null> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  gemini: 'gemini',
  grok: 'grok',
  aider: 'aider',
  'cursor-agent': 'cursor-agent',
  amp: 'amp',
  generic: null,
  terminal: null,
  dev: null,
};

const MODE_LABELS: Record<SessionPermissionMode, string> = {
  default: 'Interactive (ask)',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan (read-only)',
  autonomous: 'Autonomous (no prompts)',
};

const MODE_HINTS: Record<SessionPermissionMode, string> = {
  default: 'The agent asks before edits and commands.',
  acceptEdits: 'Auto-accepts file edits; still asks for risky actions.',
  plan: 'Read-only planning — no file writes.',
  autonomous: '⚠ No prompts at all. Use only on an isolated / sandboxed node.',
};

/**
 * The permission modes each agent ACTUALLY supports — mirrors the orchestrator's
 * per-agent flag mapping (agent-launch.ts). The options used to be the same four
 * for every CLI agent, but they aren't interchangeable: Gemini has no read-only
 * "plan" mode (it maps to the same as default), so offering it was misleading.
 * Agents not listed (opencode = in-app perms, generic/terminal/dev) show no picker.
 */
const MODES_BY_AGENT: Partial<Record<AgentType, readonly SessionPermissionMode[]>> = {
  'claude-code': ['default', 'acceptEdits', 'plan', 'autonomous'],
  codex: ['default', 'acceptEdits', 'plan', 'autonomous'],
  gemini: ['default', 'acceptEdits', 'autonomous'], // no real read-only plan mode
};

function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-2xs text-flock-ink-muted/80">{hint}</p>}
    </div>
  );
}

/** Parse a `KEY=VALUE` textarea (one per line; blank/`#` lines skipped) into a map. */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (key) out[key] = t.slice(eq + 1).trim();
  }
  return out;
}
/** Render an env map back to `KEY=VALUE` lines for the textarea. */
function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function NodeDialog(): JSX.Element {
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const closeDialog = usePaddock((s) => s.closeDialog);
  const editNodeId = usePaddock((s) => s.dialogNodeId);
  const { data: allNodes = [] } = useNodes();
  const editing = useMemo(
    () => allNodes.find((n) => n.id === editNodeId) ?? null,
    [allNodes, editNodeId],
  );

  // In edit mode the kind is fixed; credential fields start blank ("leave to keep").
  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<NodeKind>(editing?.kind ?? 'local');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(editing?.port ? String(editing.port) : '22');
  const [sshUser, setSshUser] = useState(editing?.sshUser ?? '');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(editing?.sshAuthMethod ?? 'key');
  const [key, setKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  // #3c pool + #3a env (any node kind). Env prefills from the server on edit.
  const [pool, setPool] = useState(editing?.pool ?? '');
  const [envText, setEnvText] = useState('');
  const [origEnvText, setOrigEnvText] = useState('');
  const busy = createNode.isPending || updateNode.isPending;

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    void getNodeEnv(editing.id)
      .then((r) => {
        if (!alive) return;
        const text = formatEnvText(r.env);
        setEnvText(text);
        setOrigEnvText(text);
      })
      .catch(() => {
        /* leave blank; saving without touching env won't clear it */
      });
    return () => {
      alive = false;
    };
  }, [editing]);

  async function onKeyFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setKey(await file.text());
  }

  // For key auth a private key is required (on create, or a blank-keep on edit);
  // for password auth a password is required likewise.
  const credReady = editing
    ? true // edit: blank credential = keep existing
    : authMethod === 'password'
      ? password.trim().length > 0
      : key.trim().length > 0;
  const sshReady = host.trim() && sshUser.trim() && credReady;
  const canSubmit = !!name.trim() && (kind === 'local' || sshReady);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      if (editing) {
        // Diff against the original; only send what changed (+ non-blank creds).
        const patch: Record<string, unknown> = {};
        if (name.trim() !== editing.name) patch.name = name.trim();
        if (pool.trim() !== (editing.pool ?? '')) patch.pool = pool.trim() || null;
        // Only touch env if the textarea changed (prevents a not-yet-loaded prefill
        // from silently clearing it).
        if (envText !== origEnvText) patch.env = parseEnvText(envText);
        if (editing.kind === 'ssh') {
          if (host.trim() !== (editing.host ?? '')) patch.host = host.trim();
          const portNum = Number(port) || 22;
          if (portNum !== (editing.port ?? 22)) patch.port = portNum;
          if (sshUser.trim() !== (editing.sshUser ?? '')) patch.sshUser = sshUser.trim();
          if (authMethod !== (editing.sshAuthMethod ?? 'key')) patch.sshAuthMethod = authMethod;
          if (authMethod === 'key') {
            if (key.trim()) patch.sshPrivateKey = key;
            if (passphrase.trim()) patch.sshPassphrase = passphrase;
          } else if (password.trim()) {
            patch.sshPassword = password;
          }
        }
        await updateNode.mutateAsync({ id: editing.id, input: patch });
      } else {
        // pool + env apply to any kind.
        const env = parseEnvText(envText);
        const extra = {
          ...(pool.trim() ? { pool: pool.trim() } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        if (kind === 'local') {
          await createNode.mutateAsync({ name: name.trim(), kind, ...extra });
        } else {
          await createNode.mutateAsync({
            name: name.trim(),
            kind,
            host: host.trim(),
            port: Number(port) || 22,
            sshUser: sshUser.trim(),
            sshAuthMethod: authMethod,
            ...(authMethod === 'key'
              ? { sshPrivateKey: key, ...(passphrase.trim() ? { sshPassphrase: passphrase } : {}) }
              : { sshPassword: password }),
            ...extra,
          });
        }
      }
      closeDialog();
    } catch {
      /* error toast handled by the mutation; keep the dialog open to retry */
    }
  }

  const keepHint = editing ? ' Leave blank to keep the current one.' : '';

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <HardDrive className="size-4 text-flock-accent" /> {editing ? 'Edit node' : 'Add node'}
        </DialogTitle>
        <DialogDescription>
          A node is an execution target — this machine, or a remote host over SSH.
        </DialogDescription>
      </DialogHeader>

      <Field label="Name" htmlFor="node-name">
        <Input
          id="node-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="build-box"
          autoFocus
          required
        />
      </Field>

      {/* Kind is immutable once created (delete + re-add to change it). */}
      {editing ? (
        <Field label="Kind" htmlFor="node-kind">
          <Input
            id="node-kind"
            value={kind === 'ssh' ? 'Remote (SSH)' : 'Local (this orchestrator)'}
            disabled
          />
        </Field>
      ) : (
        <Field label="Kind" htmlFor="node-kind">
          <Select value={kind} onValueChange={(v) => setKind(v as NodeKind)}>
            <SelectTrigger id="node-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local (this orchestrator)</SelectItem>
              <SelectItem value="ssh">Remote (SSH)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      {kind === 'ssh' && (
        <>
          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <Field label="Host" htmlFor="node-host">
              <Input
                id="node-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="10.0.0.5 / box.internal"
                required
              />
            </Field>
            <Field label="Port" htmlFor="node-port">
              <Input
                id="node-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <Field label="SSH user" htmlFor="node-user">
            <Input
              id="node-user"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="ubuntu"
              required
            />
          </Field>

          <Field label="Authentication" htmlFor="node-auth">
            <Select value={authMethod} onValueChange={(v) => setAuthMethod(v as SshAuthMethod)}>
              <SelectTrigger id="node-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="key">Private key</SelectItem>
                <SelectItem value="password">Password</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {authMethod === 'key' ? (
            <>
              <Field
                label="Private key"
                htmlFor="node-key"
                hint={`Paste a key or upload a file (id_ed25519, .pem). Encrypted at rest, never shown again.${keepHint}`}
              >
                <Textarea
                  id="node-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    editing ? '•••••• (keeping current key)' : '-----BEGIN OPENSSH PRIVATE KEY-----'
                  }
                />
              </Field>
              <div className="flex items-center gap-2">
                <input
                  id="node-key-file"
                  type="file"
                  onChange={onKeyFile}
                  className="block w-full text-2xs text-flock-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-flock-surface-2 file:px-3 file:py-1.5 file:text-xs file:text-flock-ink-primary hover:file:bg-flock-surface-3"
                />
              </div>
              <Field
                label="Key passphrase (optional)"
                htmlFor="node-passphrase"
                hint={`Only for an encrypted key.${keepHint}`}
              >
                <Input
                  id="node-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={editing ? '•••••• (unchanged)' : 'passphrase'}
                  autoComplete="off"
                />
              </Field>
            </>
          ) : (
            <Field
              label="Password"
              htmlFor="node-password"
              hint={`Encrypted at rest, never shown again.${keepHint}`}
            >
              <Input
                id="node-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={editing ? '•••••• (keeping current)' : 'password'}
                autoComplete="off"
              />
            </Field>
          )}
        </>
      )}

      <Field
        label="Pool (optional)"
        htmlFor="node-pool"
        hint="A group label to organize the fleet (e.g. gpu, us-east)."
      >
        <Input
          id="node-pool"
          value={pool}
          onChange={(e) => setPool(e.target.value)}
          placeholder="ungrouped"
        />
      </Field>

      <Field
        label="Environment (optional)"
        htmlFor="node-env"
        hint="KEY=VALUE per line, merged into every agent launched on this node (a session's own vars win). Encrypted at rest."
      >
        <Textarea
          id="node-env"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={'HTTPS_PROXY=http://proxy:8080\nNODE_OPTIONS=--max-old-space-size=4096'}
          className="font-mono text-xs"
        />
      </Field>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !canSubmit}>
          {busy ? (editing ? 'Saving…' : 'Adding…') : editing ? 'Save changes' : 'Add node'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Sentinel for the opt-in "Auto (best node)" placement choice (#3b). */
const AUTO_NODE = '__auto__';

function AddProjectDialog(): JSX.Element {
  const { data: nodes = [] } = useNodes();
  const { data: sessions = [] } = useSessions();
  const fixedNodeId = usePaddock((s) => s.dialogNodeId);
  const createProject = useCreateProject();
  const closeDialog = usePaddock((s) => s.closeDialog);
  const [nodeId, setNodeId] = useState(fixedNodeId ?? nodes[0]?.id ?? '');
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [browseOpen, setBrowseOpen] = useState(false);
  const busy = createProject.isPending;

  // Auto resolves to the least-busy reachable node (opt-in only). Show which one.
  const autoTarget = useMemo(() => pickBestNode(nodes, sessions), [nodes, sessions]);
  const effectiveNodeId = nodeId === AUTO_NODE ? (autoTarget?.id ?? '') : nodeId;
  const selectedNode = nodes.find((n) => n.id === effectiveNodeId);
  // Browsing runs a command on the node, so it needs a reachable transport: a
  // local node, or an ssh node that is currently connected.
  const canBrowse =
    !!selectedNode &&
    (selectedNode.kind === 'local' || selectedNode.connectionStatus === 'connected');

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const resolvedNodeId = nodeId === AUTO_NODE ? autoTarget?.id : nodeId;
    if (!resolvedNodeId) return; // Auto found no reachable node — nothing to do
    try {
      await createProject.mutateAsync({
        nodeId: resolvedNodeId,
        name: name.trim(),
        workingDir: workingDir.trim(),
      });
      closeDialog();
    } catch {
      /* error toast handled by the mutation */
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FolderGit2 className="size-4 text-flock-accent" /> Add project
        </DialogTitle>
        <DialogDescription>A working directory / repo root on a node.</DialogDescription>
      </DialogHeader>

      <Field
        label="Node"
        htmlFor="proj-node"
        hint={
          nodeId === AUTO_NODE
            ? autoTarget
              ? `Auto → ${autoTarget.name} (least busy${autoTarget.pool ? ` · ${autoTarget.pool}` : ''})`
              : 'Auto → no reachable node available'
            : undefined
        }
      >
        <Select value={nodeId} onValueChange={setNodeId} disabled={!!fixedNodeId}>
          <SelectTrigger id="proj-node">
            <SelectValue placeholder="Select a node" />
          </SelectTrigger>
          <SelectContent>
            {!fixedNodeId ? <SelectItem value={AUTO_NODE}>✨ Auto (best node)</SelectItem> : null}
            {nodes.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.name}
                {n.pool ? ` · ${n.pool}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Name" htmlFor="proj-name">
        <Input
          id="proj-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="flock"
          autoFocus
          required
        />
      </Field>
      <Field
        label="Working directory"
        htmlFor="proj-dir"
        hint={canBrowse ? undefined : 'Connect the node to browse, or type the path.'}
      >
        <div className="flex items-center gap-2">
          <Input
            id="proj-dir"
            className="flex-1"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/home/mj/mjcode/flock"
            required
          />
          <Button
            type="button"
            variant="secondary"
            size="md"
            disabled={!canBrowse}
            onClick={() => setBrowseOpen(true)}
            title={canBrowse ? 'Browse folders on the node' : 'Node must be connected to browse'}
          >
            <FolderOpen className="size-4" /> Browse
          </Button>
        </div>
      </Field>

      {browseOpen && selectedNode && (
        <PathBrowser
          nodeId={selectedNode.id}
          initialPath={workingDir.trim() || undefined}
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onSelect={(p) => setWorkingDir(p)}
        />
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !nodeId || !name.trim() || !workingDir.trim()}>
          {busy ? 'Adding…' : 'Add project'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function AddSessionDialog(): JSX.Element {
  const { data: projects = [] } = useProjects();
  const fixedProjectId = usePaddock((s) => s.dialogProjectId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const createSession = useCreateSession();
  const closeDialog = usePaddock((s) => s.closeDialog);
  const openAgent = usePaddock((s) => s.openAgent);
  // Prefer dialog scope → active project on stage → first project (two-click target).
  const [projectId, setProjectId] = useState(
    fixedProjectId ?? selectedProjectId ?? projects[0]?.id ?? '',
  );
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [permissionMode, setPermissionMode] = useState<SessionPermissionMode>('default');
  const [devCommand, setDevCommand] = useState('');
  const [presets, setPresets] = useState<LauncherPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const busy = createSession.isPending;

  useEffect(() => {
    void fetchLauncherPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  /** Two-click path: pick a preset → apply agent/mode (optionally auto-start). */
  function applyPreset(p: LauncherPreset): void {
    setSelectedPresetId(p.id);
    setAgentType(p.agentType);
    if (p.permissionMode) setPermissionMode(p.permissionMode);
  }
  // Only the modes THIS agent supports; if the current selection isn't valid for
  // the chosen agent (e.g. switched to Gemini while "plan" was picked), fall back
  // to default so we never send an unsupported mode.
  const modes = MODES_BY_AGENT[agentType] ?? [];
  const showMode = modes.length > 0;
  const effectiveMode: SessionPermissionMode = modes.includes(permissionMode)
    ? permissionMode
    : 'default';
  const isDev = agentType === 'dev';

  const project = projects.find((p) => p.id === projectId);

  // Grey out agents whose CLI isn't installed on this project's node (flock-agentd
  // detection, NodeInfo.agents) so you can't pick one that would fail at launch
  // with "executable not found". Fail-OPEN while detection is unknown (loading, or
  // a node that doesn't report info) so we never block every agent.
  const nodeInfoQuery = useNodeInfo(project?.nodeId ?? null);
  const detected = useMemo(
    () => new Set((nodeInfoQuery.data?.agents ?? []).map((a) => a.name)),
    [nodeInfoQuery.data],
  );
  const detectionKnown = nodeInfoQuery.isSuccess;
  const agentAvailable = (a: AgentType): boolean => {
    const bin = REQUIRED_BIN[a];
    if (bin === null) return true; // bare shell / dev — needs no agent CLI
    if (!detectionKnown) return true; // unknown yet → don't block
    return detected.has(bin);
  };

  // If the chosen node doesn't have the selected agent's CLI, fall back to the
  // first offered agent it DOES have (terminal needs none, so there's always one).
  useEffect(() => {
    if (!detectionKnown) return;
    const ok = (a: AgentType): boolean =>
      REQUIRED_BIN[a] === null || detected.has(REQUIRED_BIN[a] as string);
    if (ok(agentType)) return;
    const next = (Object.keys(AGENT_LABELS) as AgentType[]).find((a) => a !== 'generic' && ok(a));
    if (next && next !== agentType) setAgentType(next);
  }, [detectionKnown, detected, agentType]);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      const { session } = await createSession.mutateAsync({
        projectId,
        agentType,
        // Only send a mode for agents that honor it; default otherwise.
        ...(showMode && effectiveMode !== 'default' ? { permissionMode: effectiveMode } : {}),
        // Dev session: the supervised, auto-restarting command (sh -lc on the node).
        ...(isDev ? { devCommand: devCommand.trim() } : {}),
      });
      // Open on stage (agents lens + terminal-first chrome).
      openAgent(session.id, session.projectId);
      closeDialog();
    } catch {
      /* error toast handled by the mutation */
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Bot className="size-4 text-flock-accent" /> Start session
        </DialogTitle>
        <DialogDescription>One agent instance, one session, one status.</DialogDescription>
      </DialogHeader>

      <Field label="Project" htmlFor="sess-project">
        <Select value={projectId} onValueChange={setProjectId} disabled={!!fixedProjectId}>
          <SelectTrigger id="sess-project">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {presets.length > 0 ? (
        <div data-testid="launcher-presets" className="grid gap-1.5">
          <Label>Quick launch preset</Label>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => {
              const avail = agentAvailable(p.agentType);
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`launcher-preset-${p.id}`}
                  data-selected={selectedPresetId === p.id ? '1' : '0'}
                  disabled={!avail || busy}
                  onClick={() => applyPreset(p)}
                  className={`rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors ${
                    selectedPresetId === p.id
                      ? 'border-flock-accent bg-flock-accent/15 text-flock-accent'
                      : 'border-[var(--flock-border)] bg-flock-surface-1 text-flock-ink-muted hover:border-flock-accent/50'
                  } disabled:opacity-40`}
                >
                  {p.name}
                  {!avail ? ' · n/a' : ''}
                </button>
              );
            })}
          </div>
          <p className="text-2xs text-flock-ink-muted/80">
            Pick a preset, then Start — launches into the selected project (two-click path).
          </p>
        </div>
      ) : null}

      <Field label="Agent" htmlFor="sess-agent">
        <Select value={agentType} onValueChange={(v) => setAgentType(v as AgentType)}>
          <SelectTrigger id="sess-agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* `generic` is hidden: it's a bare shell, redundant with `terminal`.
                Kept in the model for any legacy sessions, just not offered here. */}
            {(Object.keys(AGENT_LABELS) as AgentType[])
              .filter((a) => a !== 'generic')
              .map((a) => {
                const avail = agentAvailable(a);
                return (
                  <SelectItem key={a} value={a} disabled={!avail}>
                    {AGENT_LABELS[a]}
                    {avail ? '' : ' · not installed on node'}
                  </SelectItem>
                );
              })}
          </SelectContent>
        </Select>
      </Field>
      {showMode ? (
        <Field label="Mode" htmlFor="sess-mode" hint={MODE_HINTS[effectiveMode]}>
          <Select
            value={effectiveMode}
            onValueChange={(v) => setPermissionMode(v as SessionPermissionMode)}
          >
            <SelectTrigger id="sess-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modes.map((m) => (
                <SelectItem key={m} value={m}>
                  {MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {isDev ? (
        <Field
          label="Command"
          htmlFor="sess-devcmd"
          hint="Runs via the node shell and auto-restarts if it exits (e.g. crash). Close the session to stop it."
        >
          <Input
            id="sess-devcmd"
            value={devCommand}
            onChange={(e) => setDevCommand(e.target.value)}
            placeholder="npm run dev"
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            busy || !projectId || !agentAvailable(agentType) || (isDev && !devCommand.trim())
          }
        >
          {busy ? 'Starting…' : 'Start session'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Confirm before terminating a session — destructive (kills the agent and its
 * session; in-progress work is lost), so it is gated behind an explicit
 * confirm rather than firing on the row's X click.
 */
function TerminateSessionDialog(): JSX.Element {
  const sessionId = usePaddock((s) => s.dialogSessionId);
  const closeDialog = usePaddock((s) => s.closeDialog);
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectSession = usePaddock((s) => s.selectSession);
  const { data: sessions = [] } = useSessions();
  const terminate = useTerminateSession();
  const session = sessions.find((s) => s.id === sessionId);
  const busy = terminate.isPending;

  async function onConfirm(): Promise<void> {
    if (!sessionId) return;
    try {
      await terminate.mutateAsync(sessionId);
      if (selectedSessionId === sessionId) selectSession(null);
      closeDialog();
    } catch {
      /* error toast handled by the mutation */
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-status-error" /> Terminate session?
        </DialogTitle>
        <DialogDescription>
          This stops the agent and kills its session
          {session ? ` (${session.agentType} · ${session.id.slice(0, 6)})` : ''}. Any in-progress
          work that isn’t saved will be lost. This can’t be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={onConfirm}
          disabled={busy || !sessionId}
        >
          {busy ? 'Terminating…' : 'Terminate'}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** Host that renders whichever dialog the store has open. */
/** flock.yml — paste/edit a workspace config + apply it, or export the current fleet. */
function ConfigDialog(): JSX.Element {
  const qc = useQueryClient();
  const [yaml, setYaml] = useState('');
  const [summary, setSummary] = useState<ConfigApplySummary | null>(null);
  const exp = useMutation({
    mutationFn: exportConfig,
    onSuccess: (r) => {
      setYaml(r.yaml);
      setSummary(null);
    },
  });
  const apply = useMutation({
    mutationFn: () => applyConfig(yaml),
    onSuccess: (s) => {
      setSummary(s);
      void qc.invalidateQueries();
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Config as code (flock.yml)</DialogTitle>
        <DialogDescription>
          Define your fleet — projects, working dirs, and agents — then apply it. Re-applying is
          idempotent: existing projects and running agents are reused.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        rows={13}
        placeholder={
          'projects:\n  - node: node-vm-1\n    name: my-app\n    path: /home/flock/my-app\n    agents:\n      - type: claude-code\n        mode: plan\n      - type: codex'
        }
        className="font-mono text-xs leading-relaxed"
      />
      {apply.isError ? (
        <p className="text-xs text-status-error">{(apply.error as Error).message}</p>
      ) : null}
      {summary ? (
        <div className="rounded-md border border-[var(--flock-border)] bg-flock-surface-2 p-2 text-2xs">
          <p className="text-flock-ink-primary">
            Created {summary.projectsCreated.length} project(s) · {summary.sessionsCreated.length}{' '}
            agent(s).
          </p>
          {summary.warnings.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-flock-ink-muted">
              {summary.warnings.slice(0, 8).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onClick={() => exp.mutate()} disabled={exp.isPending}>
          {exp.isPending ? 'Loading…' : 'Export current'}
        </Button>
        <Button onClick={() => apply.mutate()} disabled={!yaml.trim() || apply.isPending}>
          {apply.isPending ? 'Applying…' : 'Apply'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Race a task across N agents, then compare their results. */
const RACE_AGENTS: AgentType[] = ['claude-code', 'codex', 'gemini', 'grok', 'opencode'];
function RaceDialog(): JSX.Element {
  const setRace = usePaddock((s) => s.setRace);
  const { data: projects = [] } = useProjects();
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [task, setTask] = useState('');
  const [picked, setPicked] = useState<Set<AgentType>>(
    () => new Set<AgentType>(['claude-code', 'codex']),
  );
  const toggle = (a: AgentType): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  const run = useMutation({
    mutationFn: () => startRace(projectId, task.trim(), [...picked]),
    onSuccess: (r) => setRace({ task: r.task, sessionIds: r.sessionIds }),
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Race a task</DialogTitle>
        <DialogDescription>
          Run the same task across several agents, then compare their changes side by side. Flock
          observes Git state but does not isolate or manage it.
        </DialogDescription>
      </DialogHeader>
      <Field label="Project" htmlFor="race-project">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger id="race-project">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Task" htmlFor="race-task" hint="Sent to every racer as its first instruction.">
        <Textarea
          id="race-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          placeholder="e.g. Add a /healthz endpoint with a test."
        />
      </Field>
      <Field label="Agents" htmlFor="race-agents">
        <div className="flex flex-wrap gap-2">
          {RACE_AGENTS.map((a) => {
            const on = picked.has(a);
            return (
              <button
                key={a}
                type="button"
                onClick={() => toggle(a)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  on
                    ? 'border-flock-accent/40 bg-flock-accent/15 text-flock-accent'
                    : 'border-[var(--flock-border)] text-flock-ink-muted hover:bg-flock-surface-2'
                }`}
              >
                {AGENT_LABELS[a]}
              </button>
            );
          })}
        </div>
      </Field>
      {run.isError ? (
        <p className="text-xs text-status-error">{(run.error as Error).message}</p>
      ) : null}
      <DialogFooter>
        <Button
          disabled={!projectId || task.trim().length === 0 || picked.size < 2 || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? 'Spawning…' : `Race ${picked.size} agents`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function PaddockDialogs(): JSX.Element {
  const dialog = usePaddock((s) => s.dialog);
  const closeDialog = usePaddock((s) => s.closeDialog);
  const open =
    dialog === 'node' ||
    dialog === 'project' ||
    dialog === 'session' ||
    dialog === 'terminate-session' ||
    dialog === 'config' ||
    dialog === 'race';

  // Reset internal form state by remounting the body each time the kind changes.
  const body = useMemo(() => {
    if (dialog === 'node') return <NodeDialog />;
    if (dialog === 'project') return <AddProjectDialog />;
    if (dialog === 'session') return <AddSessionDialog />;
    if (dialog === 'terminate-session') return <TerminateSessionDialog />;
    if (dialog === 'config') return <ConfigDialog />;
    if (dialog === 'race') return <RaceDialog />;
    return null;
  }, [dialog]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent>{body}</DialogContent>
    </Dialog>
  );
}
