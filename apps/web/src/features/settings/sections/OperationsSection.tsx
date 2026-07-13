import { useCallback, useEffect, useState } from 'react';
import type { FlockDiagnostics } from '@flock/shared';
import { Download, RefreshCw } from 'lucide-react';
import { Badge, Button } from '../../../components/ui';
import { SectionHeader, SettingCard, SettingRow } from '../SettingsSection';
import { fetchDiagnostics } from '../diagnosticsApi';
import { PRODUCT_NAME } from '../../../brand';

function label(status: string): 'success' | 'danger' | 'warning' {
  return status === 'ready' || status === 'available' || status === 'configured'
    ? 'success'
    : status === 'not_configured'
      ? 'warning'
      : 'danger';
}

export function OperationsSection(): JSX.Element {
  const [data, setData] = useState<FlockDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void fetchDiagnostics()
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Diagnostics failed'));
  }, []);
  useEffect(load, [load]);

  return (
    <div>
      <SectionHeader
        title="Operations"
        description="Dependency health, runtime versions, and bounded recent failures."
        action={
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      />
      {error ? (
        <p role="alert" className="mb-4 text-sm text-flock-danger">
          {error}
        </p>
      ) : null}
      {data ? (
        <>
          {data.warnings.length > 0 ? (
            <div className="mb-4 rounded-lg border border-flock-warning/40 bg-flock-warning/10 p-3 text-sm">
              {data.warnings.join(' · ')}
            </div>
          ) : null}
          <SettingCard>
            {Object.entries({
              Database: data.health.database.status,
              Migrations: data.health.migrations.status,
              'Browser runtime': data.health.browserRuntime.status,
              Push: data.health.push.status,
            }).map(([name, status]) => (
              <SettingRow key={name} title={name}>
                <Badge variant={label(status)}>{status.replace('_', ' ')}</Badge>
              </SettingRow>
            ))}
          </SettingCard>
          <div className="mt-4 flex items-center justify-between rounded-lg border border-[var(--flock-border)] bg-flock-surface-1 p-4">
            <div>
              <p className="text-sm font-medium">
                {PRODUCT_NAME} {data.versions.flock}
              </p>
              <p className="text-2xs text-flock-ink-muted">
                {data.diagnostics.events.length} recent failure events · secrets and terminal
                content excluded
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <a href="/api/diagnostics/bundle" download>
                <Download className="size-4" /> Download bundle
              </a>
            </Button>
          </div>
        </>
      ) : !error ? (
        <p className="text-sm text-flock-ink-muted">Loading diagnostics…</p>
      ) : null}
    </div>
  );
}
