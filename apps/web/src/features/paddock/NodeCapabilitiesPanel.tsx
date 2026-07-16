import { useState } from 'react';
import {
  Box,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Package,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { NODE_TOOL_CATALOG, type NodeDockerAction, type NodeToolCapability } from '@flock/shared';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui';
import {
  useConfigureNodeDocker,
  useInstallNodeTool,
  useLatestVersion,
  useNodeCapabilities,
} from '../../data/queries';
import { FLOCK_VERSION } from '../../version';

type PendingAction =
  | { kind: 'tool'; tool: NodeToolCapability }
  | { kind: 'docker'; action: NodeDockerAction };

function toolDocumentation(id: NodeToolCapability['id']): string {
  return NODE_TOOL_CATALOG.find((tool) => tool.id === id)?.documentationUrl ?? '#';
}

/** True when `latest` is a strictly higher major.minor.patch than `current`. */
function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string): number[] =>
    (v.split('-')[0] ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i += 1) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

const UPDATE_COMMAND = 'docker compose pull && docker compose up -d';

/**
 * The bundled/local runtime can't do per-tool managed installs — its toolset is
 * baked into the Shepherd image and moves with the app. Instead of a dead-end
 * warning, show what version is running, whether a newer release exists, and the
 * one command that updates it.
 */
function BundledRuntimeCard(): JSX.Element {
  const latest = useLatestVersion();
  const [copied, setCopied] = useState(false);
  const latestVersion = latest.data?.latest ?? null;
  const updateAvailable = latestVersion != null && isNewerVersion(latestVersion, FLOCK_VERSION);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command stays visible to copy by hand */
    }
  };

  return (
    <div
      data-testid="bundled-runtime-card"
      className="rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-flock-surface-2">
          <Box className="size-4 text-flock-ink-muted" />
        </span>
        <h3 className="text-sm font-semibold text-flock-ink-primary">Bundled runtime</h3>
        <Badge variant="neutral">v{FLOCK_VERSION}</Badge>
        {updateAvailable ? (
          <Badge variant="warning">Update available · v{latestVersion}</Badge>
        ) : latestVersion != null ? (
          <Badge variant="success">Up to date</Badge>
        ) : null}
      </div>
      <p className="mt-2 max-w-2xl text-xs text-flock-ink-muted">
        This node&rsquo;s coding tools ship inside Shepherd and update together, so per-tool installs
        aren&rsquo;t available here. Update Shepherd to change its bundled tools.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded-md border border-[var(--flock-border)] bg-flock-surface-0 px-2 py-1 font-mono text-2xs text-flock-ink-primary">
          {UPDATE_COMMAND}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          aria-label="Copy update command"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function dockerActionTitle(action: NodeDockerAction): string {
  if (action === 'install') return 'Install or repair Docker Engine?';
  return action === 'enable_agent_access'
    ? 'Enable Docker for Shepherd agents?'
    : 'Disable Docker for Shepherd agents?';
}

export function NodeCapabilitiesPanel({ nodeId }: { nodeId: string }): JSX.Element {
  const capabilities = useNodeCapabilities(nodeId);
  const installTool = useInstallNodeTool();
  const configureDocker = useConfigureNodeDocker();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const busy = installTool.isPending || configureDocker.isPending;
  const data = capabilities.data;
  const sharedPreparationReason = data?.tools.find(
    (tool) => !tool.installSupported && tool.installReason,
  )?.installReason;
  // The bundled/local runtime is immutable (baked into the image); other
  // install-unsupported reasons (e.g. an outdated node preparation) keep the
  // plain banner. Only the bundled case gets the version + update-command card.
  const isBundledRuntime = sharedPreparationReason?.includes('bundled local runtime is immutable');

  const runPending = async (): Promise<void> => {
    if (!pending) return;
    try {
      const result =
        pending.kind === 'tool'
          ? await installTool.mutateAsync({ nodeId, tool: pending.tool.id })
          : await configureDocker.mutateAsync({ nodeId, action: pending.action });
      setLastSummary(result.summary);
      setPending(null);
    } catch {
      // Mutations own the visible error toast; keep the dialog open for context/retry.
    }
  };

  return (
    <section aria-labelledby="node-capabilities-heading">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id="node-capabilities-heading" className="text-sm font-semibold text-flock-ink-primary">
          Coding tools & Docker
        </h2>
        <span className="text-xs text-flock-ink-muted">
          Detected automatically; installation always requires confirmation.
        </span>
      </div>

      {!data ? (
        <div className="rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4 text-sm text-flock-ink-muted">
          {capabilities.isLoading
            ? 'Inspecting node capabilities…'
            : 'Node capabilities are unavailable.'}
        </div>
      ) : (
        <div className="space-y-4">
          {isBundledRuntime ? (
            <BundledRuntimeCard />
          ) : sharedPreparationReason ? (
            <div className="rounded-lg border border-status-awaiting/30 bg-status-awaiting/5 px-3 py-2 text-xs text-status-awaiting">
              Managed installs are unavailable. {sharedPreparationReason}
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {data.tools.map((tool) => (
              <article
                key={tool.id}
                data-testid={`node-tool-${tool.id}`}
                className="flex min-h-44 flex-col rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4"
              >
                <div className="flex items-start gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-flock-surface-2">
                    <Package className="size-4 text-flock-ink-muted" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-flock-ink-primary">
                      {tool.label}
                    </h3>
                    <Badge variant={tool.integration === 'first_class' ? 'accent' : 'outline'}>
                      {tool.integration === 'first_class' ? 'First-class' : 'Terminal integration'}
                    </Badge>
                  </div>
                  <Badge variant={tool.installed ? 'success' : 'neutral'}>
                    {tool.installed ? 'Installed' : 'Missing'}
                  </Badge>
                </div>

                <p
                  className="mt-3 truncate font-mono text-2xs text-flock-ink-muted"
                  title={tool.version ?? tool.path ?? undefined}
                >
                  {tool.version ?? tool.path ?? `Requires ${tool.binary}`}
                </p>
                <p className="mt-1 text-2xs text-flock-ink-muted">
                  Authentication is handled by the tool when you first launch it.
                </p>
                {!tool.installSupported &&
                tool.installReason &&
                tool.installReason !== sharedPreparationReason ? (
                  <p className="mt-2 text-2xs text-status-awaiting">{tool.installReason}</p>
                ) : null}

                <div className="mt-auto flex items-center gap-2 pt-3">
                  <Button
                    size="sm"
                    variant={tool.installed ? 'outline' : 'secondary'}
                    disabled={!tool.installSupported || busy}
                    onClick={() => setPending({ kind: 'tool', tool })}
                  >
                    <Wrench className="size-3.5" /> {tool.installed ? 'Upgrade' : 'Install latest'}
                  </Button>
                  <Button size="icon-sm" variant="ghost" asChild>
                    <a
                      href={toolDocumentation(tool.id)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${tool.label} installation instructions`}
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                </div>
              </article>
            ))}
          </div>

          <article
            data-testid="node-docker-capability"
            className="rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-4"
          >
            <div className="flex flex-wrap items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-flock-surface-2">
                {data.docker.agentAccess ? (
                  <ShieldAlert className="size-4 text-status-awaiting" />
                ) : (
                  <ShieldCheck className="size-4 text-flock-ink-muted" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-flock-ink-primary">Docker</h3>
                  <Badge variant={data.docker.installed ? 'success' : 'neutral'}>
                    {data.docker.installed ? 'Installed' : 'Missing'}
                  </Badge>
                  <Badge variant={data.docker.daemonRunning ? 'success' : 'outline'}>
                    Daemon {data.docker.daemonRunning ? 'running' : 'stopped'}
                  </Badge>
                  <Badge variant={data.docker.agentAccess ? 'warning' : 'outline'}>
                    Agent access {data.docker.agentAccess ? 'enabled' : 'disabled'}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-2xs text-flock-ink-muted">
                  {data.docker.version ?? 'Docker Engine was not detected.'}
                </p>
                <p className="mt-2 max-w-3xl text-xs text-flock-ink-muted">
                  Installing Docker does not grant agent access. Enabling system Docker allows the
                  isolated Shepherd runtime to control the daemon and is effectively root access to
                  this node.
                </p>
                {data.docker.reason ? (
                  <p className="mt-2 text-xs text-status-awaiting">{data.docker.reason}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(!data.docker.installed || !data.docker.daemonRunning) &&
                data.docker.installSupported ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setPending({ kind: 'docker', action: 'install' })}
                  >
                    {data.docker.installed ? 'Start / repair' : 'Install Docker'}
                  </Button>
                ) : null}
                {data.docker.installed && !data.docker.agentAccess ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      busy || !data.docker.daemonRunning || !data.docker.accessManagementSupported
                    }
                    onClick={() => setPending({ kind: 'docker', action: 'enable_agent_access' })}
                  >
                    Enable for agents
                  </Button>
                ) : null}
                {data.docker.agentAccess ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !data.docker.accessManagementSupported}
                    onClick={() => setPending({ kind: 'docker', action: 'disable_agent_access' })}
                  >
                    Disable agent access
                  </Button>
                ) : null}
                <Button size="icon-sm" variant="ghost" asChild>
                  <a
                    href="https://docs.docker.com/engine/install/"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Docker Engine installation instructions"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              </div>
            </div>
          </article>

          {lastSummary ? (
            <details className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-flock-ink-primary">
                Last installation output
              </summary>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-2xs text-flock-ink-muted">
                {lastSummary}
              </pre>
            </details>
          ) : null}
        </div>
      )}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === 'tool'
                ? `${pending.tool.installed ? 'Upgrade' : 'Install'} ${pending.tool.label}?`
                : pending?.kind === 'docker'
                  ? dockerActionTitle(pending.action)
                  : 'Confirm node operation'}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'tool' ? (
                <>
                  Shepherd will run the tool’s official latest-channel installer as the isolated
                  node runtime user, verify the executable, and leave authentication to the tool.
                  Existing installations are upgraded in place.
                </>
              ) : pending?.kind === 'docker' && pending.action === 'install' ? (
                <>
                  Shepherd will install or repair the distribution Docker package and enable its
                  system service. This changes the node, but does not grant agents Docker access.
                </>
              ) : pending?.kind === 'docker' && pending.action === 'enable_agent_access' ? (
                <>
                  Docker daemon access is root-equivalent. Shepherd will grant only its isolated
                  runtime identity an explicit persistent socket ACL. Human Docker-group access is
                  preserved.
                </>
              ) : (
                <>
                  Shepherd will remove its runtime socket ACL. Running agent sessions must finish
                  before access can be disabled.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant={
                pending?.kind === 'docker' && pending.action === 'enable_agent_access'
                  ? 'destructive'
                  : 'primary'
              }
              disabled={!pending || busy}
              onClick={() => void runPending()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {busy ? 'Working…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
