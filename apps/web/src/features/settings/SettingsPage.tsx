/**
 * SettingsPage — a full-page settings surface with its own inner sidebar.
 *
 * Replaces the old SettingsDialog so settings can grow without cramming a modal.
 * Sections are registry-driven: add a section by appending one entry to
 * SETTINGS_SECTIONS (label + icon + component) — the inner nav and the content
 * switch update automatically. The active section lives in the paddock UI store
 * so deep entry points (sidebar, command palette) can open a specific section.
 */
import {
  ArrowLeft,
  Bell,
  HardDrive,
  Info,
  Palette,
  Activity,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SimpleTooltip,
} from '../../components/ui';
import { FlockMark } from '../../components/SheepIcon';
import { usePaddock, type SettingsSection } from '../../store/paddock';
import { AppearanceSection } from './sections/AppearanceSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { NodesSection } from './sections/NodesSection';
import { AccountSection } from './sections/AccountSection';
import { AboutSection } from './sections/AboutSection';
import { OperationsSection } from './sections/OperationsSection';

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
  { id: 'operations', label: 'Operations', Icon: Activity, Component: OperationsSection },
  { id: 'about', label: 'About', Icon: Info, Component: AboutSection },
];

export function SettingsPage(): JSX.Element {
  const active = usePaddock((s) => s.settingsSection);
  const setSection = usePaddock((s) => s.setSettingsSection);
  const closeSettings = usePaddock((s) => s.closeSettings);

  const current = SETTINGS_SECTIONS.find((s) => s.id === active) ?? DEFAULT_SECTION;
  const Active = current.Component;

  return (
    <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-flock-surface-0 text-flock-ink-primary sm:flex-row">
      {/* Inner settings sidebar */}
      <nav
        aria-label="Settings sections"
        className="flex w-full shrink-0 flex-col border-b border-[var(--flock-border)] bg-flock-surface-1 sm:w-60 sm:border-b-0 sm:border-r"
      >
        {/* Brand header — mirrors the paddock sidebar so settings feels part of the
            same app (the wordmark was missing here). Back-to-paddock is the arrow. */}
        <header className="flex shrink-0 items-center gap-2 px-3 py-3">
          <FlockMark className="size-7" />
          <span className="font-display text-xl font-bold tracking-tight text-flock-ink-primary">
            Flock
          </span>
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
        <div className="px-3 pb-3 sm:hidden">
          <Select
            value={current.id}
            onValueChange={(value) => setSection(value as SettingsSection)}
          >
            <SelectTrigger aria-label="Settings section" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SETTINGS_SECTIONS.map(({ id, label }) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ScrollArea className="hidden w-full px-2 py-2 sm:block sm:min-h-0 sm:flex-1">
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
                    className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                      selected
                        ? 'bg-flock-accent/15 font-medium text-flock-ink-primary ring-1 ring-flock-accent/20'
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
          <div
            className="mx-auto max-w-2xl px-4 py-5 sm:px-8 sm:py-8"
            data-testid={`settings-section-${current.id}`}
          >
            <Active />
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
