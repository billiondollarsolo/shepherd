/**
 * CenterTabs — the center pane tab group: Terminal | Browser | Diff (US-33,
 * FR-UI4, spec Appendix A.1).
 *
 *   - DEFAULTS to Terminal (the live agent TUI — the Codex "center is terminal"
 *     divergence, spec §12.2 / decision row "Center pane: Terminal-first").
 *   - Browser tab mounts the Layer C screencast view (US-27 `BrowserPane`); it is
 *     mounted ONLY while selected so the screencast runs on demand (NFR-PERF3:
 *     start on tab open, stop on tab switch).
 *   - Diff tab mounts the READ-ONLY `git diff` view (this feature's `DiffTab`).
 *     Stage/commit/PR are deferred to v1.x (spec §4.2).
 *
 * Only the ACTIVE tab's panel is mounted, so switching away from Browser unmounts
 * the screencast (stopping the stream) and switching to Diff fetches fresh. Tab
 * selection is local UI state; the panels own their own data plumbing.
 *
 * The Terminal/Browser/Diff implementations are injectable so this component is
 * unit-testable without xterm/WebSocket/fetch, mirroring the feature convention.
 */
import { useState } from 'react';

import Terminal, { type TerminalProps } from '../terminal/Terminal';
import BrowserPane, { type BrowserPaneProps } from '../browser/BrowserPane';
import DiffTab, { type DiffTabProps } from './DiffTab';

export type CenterTab = 'terminal' | 'browser' | 'diff';

export interface CenterTabsProps {
  /** The single authoritative session id (spec §4.2). */
  sessionId: string;
  /** Initial tab; defaults to 'terminal' (FR-UI4). */
  initialTab?: CenterTab;
  /** Injected component overrides for tests (default to the real features). */
  components?: {
    Terminal?: (props: TerminalProps) => JSX.Element;
    BrowserPane?: (props: BrowserPaneProps) => JSX.Element;
    DiffTab?: (props: DiffTabProps) => JSX.Element;
  };
}

const TABS: ReadonlyArray<{ id: CenterTab; label: string }> = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'browser', label: 'Browser' },
  { id: 'diff', label: 'Diff' },
];

export function CenterTabs({
  sessionId,
  initialTab = 'terminal',
  components,
}: CenterTabsProps): JSX.Element {
  const [active, setActive] = useState<CenterTab>(initialTab);

  const TerminalImpl = components?.Terminal ?? Terminal;
  const BrowserPaneImpl = components?.BrowserPane ?? BrowserPane;
  const DiffTabImpl = components?.DiffTab ?? DiffTab;

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="center-tabs">
      <div
        role="tablist"
        aria-label="Session view"
        className="flex shrink-0 items-stretch gap-1 border-b border-flock-muted/15 bg-flock-surface px-2"
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`center-tab-${tab.id}`}
              data-testid={`center-tab-${tab.id}`}
              data-tab={tab.id}
              aria-selected={selected}
              aria-controls={`center-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              className={[
                'border-b-2 px-3 py-2 text-sm',
                selected
                  ? 'border-flock-accent text-flock-fg'
                  : 'border-transparent text-flock-muted hover:text-flock-fg',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`center-panel-${active}`}
        aria-labelledby={`center-tab-${active}`}
        data-testid={`center-panel-${active}`}
        data-active-tab={active}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {/* Only the active panel is mounted: switching away from Browser unmounts
            the screencast (NFR-PERF3); switching to Diff fetches fresh. */}
        {active === 'terminal' ? <TerminalImpl sessionId={sessionId} /> : null}
        {active === 'browser' ? <BrowserPaneImpl sessionId={sessionId} /> : null}
        {active === 'diff' ? <DiffTabImpl sessionId={sessionId} /> : null}
      </div>
    </div>
  );
}
