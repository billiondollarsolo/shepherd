/**
 * FleetView — the overview, rendered through the dev's chosen lens (fleetMode):
 * Command Center (MissionControl), Terminal-native, or Spatial canvas. The
 * workspace, compare/race, and handoff are shared across all three.
 */
import { usePaddock } from '../../store/paddock';
import { MissionControl } from './MissionControl';
import { TerminalFleet } from './TerminalFleet';
import { SpatialFleet } from './SpatialFleet';

export function FleetView(): JSX.Element {
  const mode = usePaddock((s) => s.fleetMode);
  if (mode === 'terminal') return <TerminalFleet />;
  if (mode === 'spatial') return <SpatialFleet />;
  return <MissionControl />;
}
