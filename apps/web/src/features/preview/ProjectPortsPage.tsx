import type { ProjectPort } from '@flock/shared';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Globe2,
  Loader2,
  Pencil,
  Plus,
  RadioTower,
  RefreshCw,
  Save,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '../../components/ui';
import {
  useForgetProjectPort,
  useActivateProjectPorts,
  useDeploymentPreviewSettings,
  useNodes,
  useProjectPorts,
  useProjects,
  useRefreshProjectPorts,
  useRelaunchProjectForward,
  useSaveProjectPort,
  useStartProjectForward,
  useStopProjectForward,
  useUpdateProjectPort,
} from '../../data/queries';
import { usePaddock } from '../../store/paddock';

interface EmbeddedPreview {
  serviceId: string;
  label: string;
  url: string;
  origin: string;
  targetPort: number;
  nodeName: string;
  projectName: string;
  backend: 'hostname' | 'port_pool';
  expiresAt: string;
}

export function ProjectPortsPage(): JSX.Element {
  const projectId = usePaddock((state) => state.selectedProjectId);
  const selectProject = usePaddock((state) => state.selectProject);
  const { data: projects = [] } = useProjects();
  const { data: nodes = [] } = useNodes();
  const project = projects.find((candidate) => candidate.id === projectId);
  const node = nodes.find((candidate) => candidate.id === project?.nodeId);
  const portsQuery = useProjectPorts(projectId);
  const deploymentSettings = useDeploymentPreviewSettings();
  const refresh = useRefreshProjectPorts(projectId);
  const activate = useActivateProjectPorts(projectId);
  const save = useSaveProjectPort(projectId);
  const update = useUpdateProjectPort(projectId);
  const forget = useForgetProjectPort(projectId);
  const start = useStartProjectForward(projectId);
  const relaunch = useRelaunchProjectForward(projectId);
  const stop = useStopProjectForward(projectId);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPort, setManualPort] = useState('3000');
  const [manualProtocol, setManualProtocol] = useState<'http' | 'https'>('http');
  const [manualLabel, setManualLabel] = useState('Web');
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [confirmForget, setConfirmForget] = useState<ProjectPort | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedPreview | null>(null);
  const [embeddedReload, setEmbeddedReload] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [blockedLaunchUrl, setBlockedLaunchUrl] = useState<string | null>(null);
  const activatedProject = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || activatedProject.current === projectId) return;
    activatedProject.current = projectId;
    activate.mutate();
  }, [activate, projectId]);

  const busy =
    save.isPending || update.isPending || start.isPending || relaunch.isPending || stop.isPending;
  const ports = portsQuery.data?.ports ?? [];
  const activeCount = ports.filter((port) => port.forward !== null).length;

  const ensureSaved = async (port: ProjectPort): Promise<ProjectPort> => {
    if (port.serviceId) return port;
    const response = await save.mutateAsync({
      targetHost: port.targetHost,
      targetPort: port.targetPort,
      protocol: port.protocol,
      label: port.label,
      autoForward: false,
    });
    return response.port;
  };

  const openPreview = async (port: ProjectPort, external: boolean): Promise<void> => {
    setActionError(null);
    setBlockedLaunchUrl(null);
    const pendingTab = external ? window.open('about:blank', '_blank') : null;
    if (pendingTab) pendingTab.opener = null;
    try {
      const saved = await ensureSaved(port);
      const result = saved.forward
        ? await relaunch.mutateAsync(saved.serviceId!)
        : await start.mutateAsync({ serviceId: saved.serviceId! });
      if (external) {
        if (pendingTab) pendingTab.location.replace(result.launchUrl);
        else setBlockedLaunchUrl(result.launchUrl);
      } else {
        setEmbedded({
          serviceId: saved.serviceId!,
          label: saved.label,
          url: result.launchUrl,
          origin: result.port.forward!.origin,
          targetPort: saved.targetPort,
          nodeName: node?.name ?? 'Unknown node',
          projectName: project?.name ?? 'Project',
          backend: result.port.forward!.backend,
          expiresAt: result.port.forward!.expiresAt,
        });
      }
    } catch (error) {
      pendingTab?.close();
      setActionError(error instanceof Error ? error.message : 'Could not open Preview.');
    }
  };

  const createManual = async (): Promise<void> => {
    const targetPort = Number(manualPort);
    if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65_535) {
      setActionError('Enter a port from 1024 to 65535.');
      return;
    }
    setActionError(null);
    try {
      await save.mutateAsync({
        targetHost: '127.0.0.1',
        targetPort,
        protocol: manualProtocol,
        label: manualLabel.trim() || `Service · ${targetPort}`,
        autoForward: false,
      });
      setManualOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the service.');
    }
  };

  const startOnly = async (port: ProjectPort): Promise<void> => {
    setActionError(null);
    try {
      const saved = await ensureSaved(port);
      await start.mutateAsync({ serviceId: saved.serviceId! });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not start forwarding.');
    }
  };

  const copyLaunchUrl = async (port: ProjectPort): Promise<void> => {
    setActionError(null);
    try {
      const saved = await ensureSaved(port);
      const result = saved.forward
        ? await relaunch.mutateAsync(saved.serviceId!)
        : await start.mutateAsync({ serviceId: saved.serviceId! });
      await navigator.clipboard.writeText(result.launchUrl);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not copy the Preview URL.');
    }
  };

  if (!projectId || !project) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-flock-ink-muted">
        Select a project to inspect its ports.
      </div>
    );
  }

  if (embedded) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-flock-bg" data-testid="embedded-preview">
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--flock-border)] bg-flock-surface-1 px-2 sm:px-3">
          <Button size="icon-sm" variant="ghost" onClick={() => setEmbedded(null)}>
            <ArrowLeft className="size-4" />
            <span className="sr-only">Back to project ports</span>
          </Button>
          <Globe2 className="size-4 shrink-0 text-flock-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-flock-ink-primary">
              {embedded.projectName} / {embedded.nodeName} / {embedded.label} :{embedded.targetPort}
            </p>
            <p className="truncate font-mono text-2xs text-flock-ink-muted">
              {embedded.origin} · expires {new Date(embedded.expiresAt).toLocaleTimeString()}
            </p>
          </div>
          {embedded.backend === 'port_pool' ? <Badge variant="warning">Private HTTP</Badge> : null}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setEmbeddedReload((value) => value + 1)}
          >
            <RefreshCw className="size-3.5" />
            <span className="sr-only">Reload Preview</span>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(embedded.origin)}
          >
            <Copy className="size-3.5" />
            <span className="sr-only">Copy Preview URL</span>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={embedded.origin} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">Open in browser</span>
            </a>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              void stop.mutateAsync(embedded.serviceId).finally(() => setEmbedded(null));
            }}
          >
            <Square className="size-3.5" />
            <span className="sr-only">Stop forwarding</span>
          </Button>
        </div>
        <div className="relative min-h-0 flex-1 bg-white">
          <iframe
            key={`${embedded.url}:${embeddedReload}`}
            src={embedded.url}
            title={`${embedded.label} Preview`}
            sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-downloads allow-popups"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
            className="absolute inset-0 size-full border-0"
          />
          {ports.find((port) => port.serviceId === embedded.serviceId)?.forward?.embedding ===
          'blocked' ? (
            <div className="absolute inset-0 grid place-items-center bg-flock-bg/95 p-6 text-center">
              <div className="max-w-md">
                <ShieldAlert className="mx-auto mb-3 size-6 text-flock-warning" />
                <p className="font-semibold text-flock-ink-primary">This app blocks embedding</p>
                <p className="mt-1 text-sm text-flock-ink-muted">
                  {ports.find((port) => port.serviceId === embedded.serviceId)?.forward
                    ?.embeddingReason ?? 'Open it in a separate browser tab instead.'}
                </p>
                <Button className="mt-4" asChild>
                  <a href={embedded.origin} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" /> Open in browser
                  </a>
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-flock-bg" data-testid="project-ports-page">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-3 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <RadioTower className="size-5 text-flock-accent" />
              <h1 className="font-display text-xl font-bold text-flock-ink-primary">Ports</h1>
              {activeCount > 0 ? <Badge variant="neutral">{activeCount} active</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-flock-ink-muted">
              Web services running on {node?.name ?? project.name}. Forwards belong to the project,
              not to one agent.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw className={`size-3.5 ${refresh.isPending ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setManualOpen((open) => !open)}>
              <Plus className="size-3.5" /> Forward a port
            </Button>
          </div>
        </header>

        {portsQuery.data?.discovery.reason ? (
          <div
            className={`rounded-lg border p-3 text-xs ${
              portsQuery.data.discovery.healthy
                ? 'border-flock-warning/30 bg-flock-warning/5 text-flock-ink-muted'
                : 'border-flock-warning/45 bg-flock-warning/10 text-flock-ink-primary'
            }`}
          >
            {portsQuery.data.discovery.reason}
          </div>
        ) : null}

        {portsQuery.data &&
        (portsQuery.data.discovery.unassignedCount > 0 ||
          portsQuery.data.discovery.ambiguousCount > 0) ? (
          <div className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-3 text-xs text-flock-ink-muted">
            {portsQuery.data.discovery.unassignedCount > 0
              ? `${portsQuery.data.discovery.unassignedCount} node listener${portsQuery.data.discovery.unassignedCount === 1 ? '' : 's'} could not be assigned to a project. `
              : ''}
            {portsQuery.data.discovery.ambiguousCount > 0
              ? `${portsQuery.data.discovery.ambiguousCount} matched more than one project. `
              : ''}
            Use <strong className="text-flock-ink-primary">Forward a port</strong> to attach one
            explicitly.
          </div>
        ) : null}

        {manualOpen ? (
          <section className="grid gap-3 rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-3 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-end">
            <label className="grid gap-1 text-xs font-medium">
              Label
              <Input value={manualLabel} onChange={(event) => setManualLabel(event.target.value)} />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Port
              <Input
                type="number"
                inputMode="numeric"
                min={1024}
                max={65535}
                value={manualPort}
                onChange={(event) => setManualPort(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Protocol
              <Select
                value={manualProtocol}
                onValueChange={(value) => setManualProtocol(value as 'http' | 'https')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="https">HTTPS</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="flex gap-2">
              <Button disabled={save.isPending} onClick={() => void createManual()}>
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save
              </Button>
              <Button size="icon" variant="ghost" onClick={() => setManualOpen(false)}>
                <X className="size-4" />
                <span className="sr-only">Cancel</span>
              </Button>
            </div>
          </section>
        ) : null}

        {portsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-flock-ink-muted">
            <Loader2 className="size-4 animate-spin" /> Detecting project services…
          </div>
        ) : portsQuery.isError ? (
          <p
            role="alert"
            className="rounded-lg border border-flock-danger/40 bg-flock-danger/10 p-3 text-sm text-flock-danger"
          >
            {portsQuery.error instanceof Error
              ? portsQuery.error.message
              : 'Could not load project ports.'}
          </p>
        ) : ports.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--flock-border)] px-4 py-12 text-center">
            <RadioTower className="mx-auto size-7 text-flock-ink-muted" />
            <p className="mt-3 text-sm font-medium text-flock-ink-primary">
              No web services detected
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs text-flock-ink-muted">
              Start a development server in this project or forward a loopback port manually.
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            {ports.map((port) => (
              <article
                key={port.id}
                className="grid gap-3 rounded-xl border border-[var(--flock-border)] bg-flock-surface-1 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {editing?.id === port.serviceId ? (
                      <form
                        className="flex min-w-0 flex-1 gap-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!port.serviceId || !editing.label.trim()) return;
                          void update
                            .mutateAsync({
                              serviceId: port.serviceId,
                              input: { label: editing.label.trim() },
                            })
                            .then(() => setEditing(null));
                        }}
                      >
                        <Input
                          autoFocus
                          value={editing.label}
                          onChange={(event) =>
                            setEditing({ ...editing, label: event.target.value })
                          }
                          className="h-7 max-w-xs"
                        />
                        <Button size="icon-sm" type="submit">
                          <Save className="size-3.5" />
                        </Button>
                      </form>
                    ) : (
                      <h2 className="truncate text-sm font-semibold text-flock-ink-primary">
                        {port.label}
                      </h2>
                    )}
                    <Badge variant={statusVariant(port)}>{statusLabel(port)}</Badge>
                    {port.forward?.backend === 'port_pool' ? (
                      <Badge variant="outline">Private port pool</Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-flock-ink-muted">
                    <span>
                      {port.protocol}://{port.targetHost}:{port.targetPort}
                    </span>
                    {port.process?.name ? (
                      <span>
                        {port.process.name}
                        {port.process.pid ? ` · pid ${port.process.pid}` : ''}
                      </span>
                    ) : null}
                    {port.forward ? (
                      <span className="truncate">
                        → {port.forward.origin} · expires{' '}
                        {new Date(port.forward.expiresAt).toLocaleTimeString()}
                      </span>
                    ) : null}
                  </div>
                  {port.remembered ? (
                    <label className="mt-2 inline-flex items-center gap-2 text-2xs text-flock-ink-muted">
                      <Switch
                        checked={port.autoForward}
                        disabled={update.isPending}
                        onCheckedChange={(checked) => {
                          if (port.serviceId)
                            update.mutate({
                              serviceId: port.serviceId,
                              input: { autoForward: checked },
                            });
                        }}
                      />
                      Auto-forward when this project is opened
                    </label>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  {!port.forward ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void startOnly(port)}
                      disabled={busy}
                    >
                      <RadioTower className="size-3.5" /> Start
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => void openPreview(port, false)}
                    disabled={
                      busy || deploymentSettings.data?.deployment.embeddingEnabled === false
                    }
                    title={deploymentSettings.data?.deployment.embeddingReason ?? undefined}
                  >
                    {start.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Globe2 className="size-3.5" />
                    )}
                    Open here
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openPreview(port, true)}
                    disabled={busy}
                  >
                    <ExternalLink className="size-3.5" /> Browser
                  </Button>
                  {port.forward && port.serviceId ? (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => void copyLaunchUrl(port)}
                        disabled={busy}
                      >
                        <Copy className="size-3.5" />
                        <span className="sr-only">Copy one-time Preview URL</span>
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => stop.mutate(port.serviceId!)}
                        disabled={busy}
                      >
                        <Square className="size-3.5" />
                        <span className="sr-only">Stop forwarding</span>
                      </Button>
                    </>
                  ) : null}
                  {port.serviceId ? (
                    <>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setEditing({ id: port.serviceId!, label: port.label })}
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">Rename service</span>
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirmForget(port)}>
                        <Trash2 className="size-3.5" />
                        <span className="sr-only">Forget service</span>
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}

        {actionError ? (
          <p
            role="alert"
            className="rounded-lg border border-flock-danger/40 bg-flock-danger/10 p-3 text-xs text-flock-danger"
          >
            {actionError}
          </p>
        ) : null}
        {blockedLaunchUrl ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-flock-warning/40 bg-flock-warning/10 p-3 text-xs text-flock-ink-primary">
            <span>Your browser blocked the new tab. Open the one-time Preview link directly.</span>
            <Button size="sm" variant="outline" asChild>
              <a
                href={blockedLaunchUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => setBlockedLaunchUrl(null)}
              >
                <ExternalLink className="size-3.5" /> Open Preview
              </a>
            </Button>
          </div>
        ) : null}

        <div className="flex gap-2 rounded-lg border border-[var(--flock-border)] p-3 text-2xs leading-relaxed text-flock-ink-muted">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-flock-warning" />
          Hostname Preview provides the strongest isolation. Private port-pool mode is designed for
          a trusted Tailnet or LAN because browser cookies are scoped to a host, not a port.
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => selectProject(projectId)}
        >
          <ArrowLeft className="size-3.5" /> Back to agents
        </Button>
      </div>

      <Dialog
        open={confirmForget !== null}
        onOpenChange={(open) => !open && setConfirmForget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forget {confirmForget?.label}?</DialogTitle>
            <DialogDescription>
              This removes the saved label and preferences and immediately stops its forward. The
              development server itself is not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmForget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={forget.isPending}
              onClick={() => {
                if (!confirmForget?.serviceId) return;
                void forget.mutateAsync(confirmForget.serviceId).then(() => setConfirmForget(null));
              }}
            >
              <Trash2 className="size-4" /> Forget service
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusLabel(port: ProjectPort): string {
  if (port.forward) return 'Forwarding';
  if (port.status === 'detected') return 'Listening';
  if (port.status === 'unreachable') return 'Unreachable';
  if (port.status === 'expired') return 'Expired';
  return 'Saved';
}

function statusVariant(port: ProjectPort): 'success' | 'warning' | 'danger' | 'neutral' {
  if (port.forward) return 'success';
  if (port.status === 'unreachable') return 'danger';
  if (port.status === 'expired') return 'warning';
  return 'neutral';
}
