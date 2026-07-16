import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Bot } from 'lucide-react';
import {
  AgentAuthorityEnum,
  authorityAllows,
  type AgentAuthority,
  type AgentType,
  type LauncherPreset,
  type NodeInfo,
  type SessionPermissionMode,
} from '@flock/shared';
import {
  Button,
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
} from '../../../components/ui';
import { usePaddock } from '../../../store/paddock';
import { useCreateSession, useNodeInfo, useProjects } from '../../../data/queries';
import { fetchLauncherPresets } from '../../shell/launcherPresetsApi';
import { DialogField as Field } from './DialogField';
import { PRODUCT_NAME } from '../../../brand';

const AGENT_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  gemini: 'Gemini',
  grok: 'Grok',
  aider: 'Aider',
  'cursor-agent': 'Cursor Agent',
  amp: 'Amp',
  terminal: 'Terminal (plain shell)',
  dev: 'Dev server (auto-restart)',
};

// Deprecated agents kept as valid types (old records) but no longer offered for
// new sessions — Gemini CLI is retiring 2026-06-18 in favour of Antigravity.
const DEPRECATED_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>(['gemini']);
const OFFERED_AGENTS = (Object.keys(AGENT_LABELS) as AgentType[]).filter(
  (a) => !DEPRECATED_AGENTS.has(a),
);

const AUTHORITY_LABELS: Record<AgentAuthority, string> = {
  callback_only: 'Independent — callback only',
  observe: 'Observe — list and read agents',
  collaborate: 'Collaborate — observe and send',
  delegate: 'Delegate — collaborate and spawn',
  manage: 'Manage — delegate and terminate',
};

const AUTHORITY_HINTS: Record<AgentAuthority, string> = {
  callback_only: 'This agent reports its own status but cannot inspect or control other agents.',
  observe: 'Can list agents in this project and read their recent output.',
  collaborate: 'Can also send tasks and replies to agents in this project.',
  delegate: 'Can also start new agents within the project policy limits.',
  manage: 'Can also terminate or restart agents. This is destructive authority.',
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
  antigravity: 'agy',
  gemini: 'gemini',
  grok: 'grok',
  aider: 'aider',
  'cursor-agent': 'cursor-agent',
  amp: 'amp',
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

/** Explain only mandatory compatibility blocks; supported older daemons stay usable. */
export function daemonLaunchBlockMessage(info: NodeInfo | undefined): string | null {
  const lifecycle = info?.lifecycle;
  const compatibility = lifecycle?.daemonCompatibility;
  if (compatibility?.state !== 'required') return null;
  const activeSessions = lifecycle?.upgrade?.activeSessions ?? 0;
  const protectedSessions =
    activeSessions > 0
      ? ` ${activeSessions} existing session${activeSessions === 1 ? '' : 's'} remain protected and must finish first; Shepherd will then upgrade the node daemon before accepting new work.`
      : '';
  return `${compatibility.detail}${protectedSessions} Upgrade the node daemon from Node details, then try again.`;
}

/**
 * The permission modes each agent ACTUALLY supports — mirrors the orchestrator's
 * per-agent flag mapping (agent-launch.ts). The options used to be the same four
 * for every CLI agent, but they aren't interchangeable: Gemini has no read-only
 * "plan" mode (it maps to the same as default), so offering it was misleading.
 * Agents not listed (opencode = in-app perms, terminal/dev) show no picker.
 */
const MODES_BY_AGENT: Partial<Record<AgentType, readonly SessionPermissionMode[]>> = {
  'claude-code': ['default', 'acceptEdits', 'plan', 'autonomous'],
  codex: ['default', 'acceptEdits', 'plan', 'autonomous'],
  antigravity: ['default', 'plan', 'acceptEdits', 'autonomous'],
  gemini: ['default', 'acceptEdits', 'autonomous'], // no real read-only plan mode
};

export function AddSessionDialog(): JSX.Element {
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
  const [authority, setAuthority] = useState<'project_default' | AgentAuthority>('project_default');
  const [confirmedManage, setConfirmedManage] = useState(false);
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
  const effectiveAuthority: AgentAuthority =
    authority === 'project_default'
      ? (project?.agentPolicy?.defaultAuthority ?? 'callback_only')
      : authority;

  useEffect(() => {
    if (
      authority !== 'project_default' &&
      project &&
      !authorityAllows(project.agentPolicy?.maxAuthority ?? 'callback_only', authority)
    ) {
      setAuthority('project_default');
    }
    setConfirmedManage(false);
  }, [project, authority]);

  // Grey out agents whose CLI isn't installed on this project's node (flock-agentd
  // detection, NodeInfo.agents) so you can't pick one that would fail at launch
  // with "executable not found". Fail-OPEN while detection is unknown (loading, or
  // a node that doesn't report info) so we never block every agent.
  const nodeInfoQuery = useNodeInfo(project?.nodeId ?? null);
  const daemonLaunchBlock = daemonLaunchBlockMessage(nodeInfoQuery.data);
  const detected = useMemo(
    () => new Set((nodeInfoQuery.data?.agents ?? []).map((a) => a.name)),
    [nodeInfoQuery.data],
  );
  const detectionKnown = nodeInfoQuery.isSuccess;
  const agentAvailable = (a: AgentType): boolean => {
    const bin = REQUIRED_BIN[a];
    if (bin === null) return true; // bare shell / dev — needs no agent CLI
    // Antigravity is brand-new: older node daemons don't report `agy` in their
    // detected-agents list yet (fixed in agentd, ships on the next daemon
    // update). Don't block it in the meantime — the launch resolves `agy` from
    // the node PATH regardless. Remove once all nodes report it.
    if (a === 'antigravity') return true;
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
    const next = OFFERED_AGENTS.find(ok);
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
        ...(authority === 'project_default' ? {} : { orchestrationAuthority: authority }),
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
          <p className="text-2xs text-flock-ink-muted">
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
            {OFFERED_AGENTS.map((a) => {
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
      <Field
        label={`${PRODUCT_NAME} authority`}
        htmlFor="sess-authority"
        hint={AUTHORITY_HINTS[effectiveAuthority]}
      >
        <Select
          value={authority}
          onValueChange={(value) => {
            setAuthority(value as 'project_default' | AgentAuthority);
            setConfirmedManage(false);
          }}
        >
          <SelectTrigger id="sess-authority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project_default">
              Project default —{' '}
              {AUTHORITY_LABELS[project?.agentPolicy?.defaultAuthority ?? 'callback_only']}
            </SelectItem>
            {AgentAuthorityEnum.options
              .filter((candidate) =>
                authorityAllows(project?.agentPolicy?.maxAuthority ?? 'callback_only', candidate),
              )
              .map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {AUTHORITY_LABELS[candidate]}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
      {effectiveAuthority === 'manage' ? (
        <label className="flex items-start gap-2 rounded-lg border border-status-error/40 bg-status-error/10 p-3 text-xs text-flock-ink-primary">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={confirmedManage}
            onChange={(event) => setConfirmedManage(event.target.checked)}
          />
          <span>
            I understand this agent can terminate or restart other agents in this project.
          </span>
        </label>
      ) : null}
      {daemonLaunchBlock ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-status-error/40 bg-status-error/10 p-3 text-xs text-flock-ink-primary"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-error" aria-hidden="true" />
          <span>
            <span className="block font-semibold">New sessions are paused on this node</span>
            <span className="mt-0.5 block text-flock-ink-muted">{daemonLaunchBlock}</span>
          </span>
        </div>
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
          loading={busy}
          loadingText="Starting…"
          disabled={
            !projectId ||
            daemonLaunchBlock !== null ||
            !agentAvailable(agentType) ||
            (isDev && !devCommand.trim()) ||
            (effectiveAuthority === 'manage' && !confirmedManage)
          }
        >
          Start session
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
