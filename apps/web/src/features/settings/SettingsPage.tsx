/**
 * SettingsPage — a full-page settings surface with its own inner sidebar.
 *
 * Replaces the old SettingsDialog so settings can grow without cramming a modal.
 * Sections are registry-driven: add a section by appending one entry to
 * SETTINGS_SECTIONS (label + icon + component) — the inner nav and the content
 * switch update automatically. The active section lives in the paddock UI store
 * so deep entry points (sidebar, command palette) can open a specific section.
 */
import { ArrowLeft, Bell, HardDrive, Info, Palette, UserCircle, type LucideIcon } from 'lucide-react';
import { Button, ScrollArea, SimpleTooltip } from '../../components/ui';
import { FlockMark } from '../../components/SheepIcon';
import { usePaddock, type SettingsSection } from '../../store/paddock';
import { AppearanceSection } from './sections/AppearanceSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { NodesSection } from './sections/NodesSection';
import { AccountSection } from './sections/AccountSection';
import { AboutSection } from './sections/AboutSection';

interface SectionDef {
  id: SettingsSection;
  label: string;
  Icon: LucideIcon;
  Component: () => JSX.Element;
}

/** The default/first section, kept as a named constant so it is never undefined. */
const DEFAULT_SECTION: SectionDef = {
  id: 'appearance',
  label: 'Appearance',
  Icon: Palette,
  Component: AppearanceSection,
};

/** The single source of truth for settings sections — extend this list to grow. */
export const SETTINGS_SECTIONS: readonly SectionDef[] = [
  DEFAULT_SECTION,
  { id: 'notifications', label: 'Notifications', Icon: Bell, Component: NotificationsSection },
  { id: 'nodes', label: 'Nodes', Icon: HardDrive, Component: NodesSection },
  { id: 'account', label: 'Account', Icon: UserCircle, Component: AccountSection },
  { id: 'about', label: 'About', Icon: Info, Component: AboutSection },
];

export function SettingsPage(): JSX.Element {
  const active = usePaddock((s) => s.settingsSection);
  const setSection = usePaddock((s) => s.setSettingsSection);
  const closeSettings = usePaddock((s) => s.closeSettings);

  const current = SETTINGS_SECTIONS.find((s) => s.id === active) ?? DEFAULT_SECTION;
  const Active = current.Component;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-flock-surface-0 text-flock-ink-primary">
      {/* Inner settings sidebar */}
      <nav
        aria-label="Settings sections"
        className="flex w-60 shrink-0 flex-col border-r border-[var(--flock-border)] bg-flock-surface-1"
      >
        {/* Brand header — mirrors the paddock sidebar so settings feels part of the
            same app (the wordmark was missing here). Back-to-paddock is the arrow. */}
        <header className="flex shrink-0 items-center gap-2 px-3 py-3">
          <FlockMark className="size-7" />
          <span className="font-display text-xl font-bold tracking-tight text-flock-ink-primary">Flock</span>
          <SimpleTooltip label="Back to the paddock">
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              aria-label="Back to the paddock"
              onClick={closeSettings}
            >
              <ArrowLeft className="size-4" />
            </Button>
          </SimpleTooltip>
        </header>
        <div className="px-3 pb-1 text-2xs font-semibold uppercase tracking-label text-flock-ink-muted">
          Settings
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 py-2">
          <ul className="grid gap-0.5">
            {SETTINGS_SECTIONS.map(({ id, label, Icon }) => {
              const selected = id === current.id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setSection(id)}
                    aria-current={selected ? 'page' : undefined}
                    data-testid={`settings-nav-${id}`}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                      selected
                        ? 'bg-flock-accent/15 font-medium text-flock-accent ring-1 ring-flock-accent/20'
                        : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
                    }`}
                  >
                    <Icon className="size-4 shrink-0" />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </nav>

      {/* Section content */}
      <main className="min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-2xl px-8 py-8" data-testid={`settings-section-${current.id}`}>
            <Active />
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
