import {
  CheckCircle2,
  CircleAlert,
  Copy,
  Loader2,
  Play,
  RadioTower,
  ShieldAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '../../../components/ui';
import {
  useDeploymentPreviewSettings,
  useTestDeploymentPreviewRouting,
  useUpdateDeploymentPreviewSettings,
} from '../../../data/queries';
import { SectionHeader, SettingCard, SettingRow } from '../SettingsSection';

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${bytes} B`;
}

export function DeploymentPreviewSection(): JSX.Element {
  const settings = useDeploymentPreviewSettings();
  const update = useUpdateDeploymentPreviewSettings();
  const testRouting = useTestDeploymentPreviewRouting();
  const [testOpen, setTestOpen] = useState(false);
  const data = settings.data;
  const config = useMemo(() => {
    if (!data) return '';
    if (data.deployment.backend === 'port_pool' && data.deployment.portRange) {
      return [
        'FLOCK_DEPLOYMENT_MODE=private-http',
        'FLOCK_ALLOW_INSECURE_HTTP=1',
        'FLOCK_PREVIEW_BACKEND=port-pool',
        `FLOCK_PREVIEW_PORT_RANGE=${data.deployment.portRange.start}-${data.deployment.portRange.end}`,
        `FLOCK_PREVIEW_FRAME_SOURCES=${data.deployment.frameSources.join(' ')}`,
        `# Firewall/Tailnet: allow the Shepherd port plus TCP ${data.deployment.portRange.start}-${data.deployment.portRange.end} only from trusted clients.`,
        'docker compose -f docker-compose.yml -f docker-compose.private-http.yml up -d --wait',
      ].join('\n');
    }
    if (data.deployment.deploymentMode === 'external-tls') {
      return [
        'FLOCK_PREVIEW_BACKEND=hostname',
        `FLOCK_PREVIEW_DOMAIN=${data.deployment.previewDomain ?? 'preview.example.com'}`,
        `FLOCK_PREVIEW_FRAME_SOURCES=${data.deployment.frameSources.join(' ')}`,
        '# Proxy the main origin /api/* and /ws* to :18080 and static UI to :18081.',
        '# Proxy *.Preview-domain HTTP + WebSocket traffic to :18082, preserving Host.',
        `# Main CSP: frame-src ${data.deployment.frameSources.join(' ') || "'none'"}`,
      ].join('\n');
    }
    return [
      'FLOCK_PREVIEW_BACKEND=hostname',
      `FLOCK_PREVIEW_DOMAIN=${data.deployment.previewDomain ?? 'preview.example.com'}`,
      `# Main-page CSP frame-src: ${data.deployment.frameSources.join(' ') || "'none'"}`,
      '# Point the dedicated Preview DNS suffix at the Shepherd edge.',
      '# Firewall: allow 80/tcp and 443/tcp; do not publish orchestrator or database ports.',
    ].join('\n');
  }, [data]);

  if (settings.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-flock-ink-muted">
        <Loader2 className="size-4 animate-spin" /> Loading Preview deployment…
      </div>
    );
  }
  if (!data) {
    return (
      <p role="alert" className="text-sm text-flock-danger">
        {settings.error instanceof Error
          ? settings.error.message
          : 'Preview settings are unavailable.'}
      </p>
    );
  }

  const deployment = data.deployment;
  const runtime = data.runtime;
  return (
    <div className="grid gap-5">
      <SectionHeader
        title="Deployment & Preview"
        description="See the effective forwarding topology, runtime controls, limits, and infrastructure restart boundaries."
      />

      {deployment.privateModeWarning ? (
        <div className="flex gap-2 rounded-lg border border-flock-warning/40 bg-flock-warning/10 p-3 text-xs leading-relaxed text-flock-ink-primary">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-flock-warning" />
          {deployment.privateModeWarning}
        </div>
      ) : null}

      <SettingCard>
        <SettingRow
          title="Forwarding backend"
          desc="Infrastructure setting · restart/redeploy required"
        >
          <Badge variant={deployment.enabled ? 'success' : 'neutral'}>
            {deployment.backend === 'port_pool'
              ? 'Private port pool'
              : deployment.backend === 'hostname'
                ? 'Hostname isolation'
                : 'Disabled'}
          </Badge>
        </SettingRow>
        <SettingRow title="Deployment mode">
          <code className="text-2xs">{deployment.deploymentMode}</code>
        </SettingRow>
        <SettingRow
          title="Gateway health"
          desc={deployment.reason ?? 'The Preview-only gateway is accepting routes.'}
        >
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${deployment.gatewayHealthy ? 'text-flock-success' : 'text-flock-danger'}`}
          >
            <CheckCircle2 className="size-3.5" />{' '}
            {deployment.gatewayHealthy ? 'Healthy' : 'Unavailable'}
          </span>
        </SettingRow>
        <SettingRow
          title="Embedded Preview"
          desc={
            deployment.embeddingReason ??
            'The control-plane CSP permits only the configured Preview origins.'
          }
        >
          <Badge variant={deployment.embeddingEnabled ? 'success' : 'neutral'}>
            {deployment.embeddingEnabled ? 'Available' : 'External only'}
          </Badge>
        </SettingRow>
        <SettingRow title="Public Shepherd URL">
          <code className="max-w-72 truncate text-2xs">
            {deployment.publicUrl ?? 'Not configured'}
          </code>
        </SettingRow>
        <SettingRow
          title={deployment.backend === 'port_pool' ? 'Published pool' : 'Preview domain'}
        >
          <code className="text-2xs">
            {deployment.portRange
              ? `${deployment.portRange.start}–${deployment.portRange.end} · ${deployment.allocatedSlots}/${deployment.portRange.capacity} allocated`
              : (deployment.previewDomain ?? 'Not configured')}
          </code>
        </SettingRow>
        <SettingRow title="Active forwards">
          <span className="text-sm tabular-nums">
            {deployment.activeForwards} / {deployment.hardLimits.maxConcurrent}
          </span>
        </SettingRow>
      </SettingCard>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-flock-ink-primary">Routing validation</h3>
            <p className="text-2xs text-flock-ink-muted">
              Checks the active backend and dedicated gateway listeners without exposing a project.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={testRouting.isPending}
            onClick={() => void testRouting.mutateAsync().then(() => setTestOpen(true))}
          >
            {testRouting.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Test routing
          </Button>
        </div>
        {testOpen && testRouting.data ? (
          <SettingCard>
            {testRouting.data.checks.map((check) => (
              <SettingRow key={check.id} title={check.id} desc={check.detail}>
                <span
                  className={
                    check.status === 'pass'
                      ? 'text-flock-success'
                      : check.status === 'warning'
                        ? 'text-flock-warning'
                        : 'text-flock-danger'
                  }
                >
                  {check.status === 'pass' ? (
                    <CheckCircle2 className="size-4" />
                  ) : (
                    <CircleAlert className="size-4" />
                  )}
                </span>
              </SettingRow>
            ))}
          </SettingCard>
        ) : null}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-flock-ink-primary">Runtime controls</h3>
        <SettingCard>
          <SettingRow
            title="Enable Preview"
            desc="Turning this off immediately revokes every active forward."
          >
            <Switch
              checked={runtime.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) => update.mutate({ enabled })}
            />
          </SettingRow>
          <SettingRow
            title="Default expiry"
            desc={`Deployment maximum: ${Math.round(deployment.hardLimits.ttlMs / 3_600_000)} hours`}
          >
            <Select
              value={String(runtime.defaultTtlMs)}
              onValueChange={(value) => update.mutate({ defaultTtlMs: Number(value) })}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 4, 8]
                  .filter((hours) => hours * 3_600_000 <= deployment.hardLimits.ttlMs)
                  .map((hours) => (
                    <SelectItem key={hours} value={String(hours * 3_600_000)}>
                      {hours} hour{hours === 1 ? '' : 's'}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="Auto-forward policy" desc="Per-service opt-in is still required.">
            <Select
              value={runtime.autoForwardPolicy}
              onValueChange={(value) =>
                update.mutate({ autoForwardPolicy: value as 'off' | 'remembered_on_access' })
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="remembered_on_access">Remembered on access</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingCard>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-flock-ink-primary">Effective hard limits</h3>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <Limit
            label="Connections / forward"
            value={deployment.hardLimits.maxConnectionsPerForward}
          />
          <Limit label="Request" value={formatBytes(deployment.hardLimits.maxRequestBytes)} />
          <Limit label="Response" value={formatBytes(deployment.hardLimits.maxResponseBytes)} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-flock-ink-primary">
              Deployment configuration
            </h3>
            <p className="text-2xs text-flock-ink-muted">
              Infrastructure changes below require a restart or redeploy.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(config)
                .then(() => toast.success('Configuration copied.'))
            }
          >
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-3 text-2xs leading-relaxed text-flock-ink-primary">
          {config}
        </pre>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {deployment.restartRequiredFields.map((field) => (
            <Badge key={field} variant="outline">
              {field} · restart
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function Limit({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-3">
      <RadioTower className="mb-2 size-3.5 text-flock-accent" />
      <p className="font-semibold text-flock-ink-primary">{value}</p>
      <p className="text-2xs text-flock-ink-muted">{label}</p>
    </div>
  );
}
