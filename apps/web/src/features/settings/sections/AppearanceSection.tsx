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
      </SettingCard>
      {/* The accent is fixed today (no picker), so it reads as a caption rather
          than a control that implies it can be changed. */}
      <p className="mt-3 inline-flex items-center gap-2 text-2xs text-flock-ink-muted">
        <span
          aria-hidden
          className="size-3 rounded-full bg-flock-accent ring-2 ring-flock-accent/30"
        />
        The paddock uses a single confident accent throughout.
      </p>
    </div>
  );
}
