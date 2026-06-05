import { useState } from 'react';
import { Button, toast } from '../../../components/ui';
import { enablePush } from '../../../push/subscribe';
import { SectionHeader, SettingCard, SettingRow } from '../SettingsSection';

export function NotificationsSection(): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function onEnablePush(): Promise<void> {
    setBusy(true);
    try {
      const r = await enablePush();
      if (r.ok) toast.success('Notifications enabled');
      else toast.error(r.reason ?? 'Could not enable notifications');
    } catch {
      toast.error('Could not enable notifications');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Notifications"
        description="Stay aware of which agent needs you, even away from the tab."
      />
      <SettingCard>
        <SettingRow
          title="Away alerts (Web Push)"
          desc="Get notified when an agent needs you, even with the tab closed."
        >
          <Button size="sm" variant="secondary" onClick={onEnablePush} disabled={busy}>
            {busy ? 'Enabling…' : 'Enable'}
          </Button>
        </SettingRow>
      </SettingCard>
      <p className="mt-3 text-2xs text-flock-ink-muted">
        Alerts fire on <span className="text-flock-ink-primary">awaiting input</span>,{' '}
        <span className="text-flock-ink-primary">done</span>, and{' '}
        <span className="text-flock-ink-primary">error</span>.
      </p>
    </div>
  );
}
