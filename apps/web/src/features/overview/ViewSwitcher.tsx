/**
 * ViewSwitcher — the dev-choosable fleet lens (⌘1/2/3): Command Center, Terminal,
 * or Spatial. A compact segmented control shown in each mode's header; the choice
 * is persisted in the paddock store (fleetMode).
 */
import { LayoutGrid, Network, SquareTerminal } from 'lucide-react';
import { usePaddock, type FleetMode } from '../../store/paddock';
import { SimpleTooltip } from '../../components/ui';

const MODES: ReadonlyArray<{ id: FleetMode; label: string; icon: typeof LayoutGrid }> = [
  { id: 'command', label: 'Command Center', icon: LayoutGrid },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'spatial', label: 'Spatial', icon: Network },
];

export function ViewSwitcher(): JSX.Element {
  const fleetMode = usePaddock((s) => s.fleetMode);
  const setFleetMode = usePaddock((s) => s.setFleetMode);
  return (
    <div
      role="tablist"
      aria-label="Fleet view"
      className="flex items-center gap-0.5 rounded-lg border border-[var(--flock-border)] p-0.5 ring-1 ring-white/[0.04]"
      style={{ backgroundColor: 'color-mix(in srgb, var(--flock-surface-2) 55%, transparent)' }}
    >
      {MODES.map((m) => {
        const Icon = m.icon;
        const active = fleetMode === m.id;
        return (
          <SimpleTooltip key={m.id} label={m.label}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`view-${m.id}`}
              onClick={() => setFleetMode(m.id)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'bg-flock-accent/15 text-flock-accent ring-1 ring-flock-accent/25'
                  : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
              }`}
            >
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{m.label}</span>
            </button>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}
