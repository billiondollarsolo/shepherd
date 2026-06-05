import { ThemeSegmented } from '../../../theme';
import { SectionHeader, SettingCard, SettingRow } from '../SettingsSection';

export function AppearanceSection(): JSX.Element {
  return (
    <div>
      <SectionHeader title="Appearance" description="How the paddock looks." />
      <SettingCard>
        <SettingRow title="Theme" desc="Light, dark, or follow the system.">
          <ThemeSegmented />
        </SettingRow>
        <SettingRow title="Accent" desc="The single confident accent across the paddock.">
          <span className="inline-flex items-center gap-2 text-xs text-flock-ink-muted">
            <span className="size-4 rounded-full bg-flock-accent ring-2 ring-flock-accent/30" />
            flock
          </span>
        </SettingRow>
      </SettingCard>
    </div>
  );
}
