/**
 * Paddock UI store (zustand) — UI-only state for the herdr-aligned shell.
 *
 * Shell model (docs/herdr-aligned-shell-plan.md):
 *   hostScope · lens (mission|agents) · chrome (stage|tools) · selection
 * No dual focus/zen modes — stage is always the drive surface; tools are opt-in.
 *
 * Server data lives in TanStack Query; this store holds NO server data.
 */
import { create } from 'zustand';
import type { HostScope, ShellChrome, ShellLens } from '@flock/shared';

/** Top-level surface. Settings is a full PAGE (not a modal). */
export type PaddockView = 'paddock' | 'settings' | 'overview';

/**
 * Which dialog is open (null = none). Settings is a view, not a dialog.
 * `terminate-session` is a destructive-action CONFIRM (not a create dialog).
 */
export type DialogKind =
  | 'node'
  | 'project'
  | 'session'
  | 'terminate-session'
  | 'config'
  | 'race'
  | null;

/** An active compare/race: the shared task + the racer session ids being compared. */
export interface ActiveRace {
  task: string;
  sessionIds: string[];
}

/** A settings page section (inner-sidebar item). Extend as settings grow. */
export type SettingsSection = 'appearance' | 'notifications' | 'nodes' | 'account' | 'about';

/** Which view the right-hand session panel shows (Codex-style side panel). */
export type RightTab = 'chat' | 'activity' | 'browser' | 'diff' | 'files' | 'search' | 'notes';

export type PenAction = {
  type: 'add' | 'remove' | 'move' | 'select' | 'create' | 'arrange' | 'rename' | 'delete';
  sessionId?: string;
  targetSessionId?: string;
  penId?: string;
  mode?: 'row' | 'col' | 'grid2x2';
  name?: string;
};

export interface PenSummary {
  id: string;
  name: string;
  sessionIds: string[];
  arrange: 'row' | 'col' | 'grid2x2';
}

/** Per-project user-defined session order (ids), persisted in localStorage. */
export type SessionOrder = Record<string, string[]>;

const ORDER_KEY = 'flock.sessionOrder';
function loadSessionOrder(): SessionOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    return raw ? (JSON.parse(raw) as SessionOrder) : {};
  } catch {
    return {};
  }
}
function saveSessionOrder(order: SessionOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* storage unavailable */
  }
}

const NODE_ORDER_KEY = 'flock.nodeOrder';
function loadNodeOrder(): string[] {
  try {
    const raw = localStorage.getItem(NODE_ORDER_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveNodeOrder(order: string[]): void {
  try {
    localStorage.setItem(NODE_ORDER_KEY, JSON.stringify(order));
  } catch {
    /* storage unavailable */
  }
}

export function orderNodes<T extends { id: string; name: string }>(
  nodes: T[],
  order: string[],
): T[] {
  const idx = new Map(order.map((id, i) => [id, i]));
  return [...nodes].sort((a, b) => {
    const ai = idx.has(a.id) ? (idx.get(a.id) as number) : Number.POSITIVE_INFINITY;
    const bi = idx.has(b.id) ? (idx.get(b.id) as number) : Number.POSITIVE_INFINITY;
    return ai !== bi ? ai - bi : a.name.localeCompare(b.name);
  });
}

const SIDEBAR_KEY = 'flock.sidebarCollapsed';
function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}
function saveSidebarCollapsed(v: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export type GridLayout = 'columns' | 'grid';
const GRID_LAYOUT_KEY = 'flock.gridLayout';
function loadGridLayout(): GridLayout {
  try {
    return localStorage.getItem(GRID_LAYOUT_KEY) === 'grid' ? 'grid' : 'columns';
  } catch {
    return 'columns';
  }
}
function saveGridLayout(v: GridLayout): void {
  try {
    localStorage.setItem(GRID_LAYOUT_KEY, v);
  } catch {
    /* storage unavailable */
  }
}

export type FleetMode = 'command' | 'terminal' | 'spatial';
const FLEET_MODE_KEY = 'flock.fleetMode';
function loadFleetMode(): FleetMode {
  try {
    const v = localStorage.getItem(FLEET_MODE_KEY);
    return v === 'terminal' || v === 'spatial' ? v : 'command';
  } catch {
    return 'command';
  }
}
function saveFleetMode(v: FleetMode): void {
  try {
    localStorage.setItem(FLEET_MODE_KEY, v);
  } catch {
    /* storage unavailable */
  }
}

const REVIEWED_KEY = 'flock.reviewedSessions';
function loadReviewed(): string[] {
  try {
    const raw = localStorage.getItem(REVIEWED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveReviewed(ids: string[]): void {
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

export interface LayoutPreset {
  id: string;
  name: string;
  projectId: string;
  gridLayout: GridLayout;
  order: string[];
}
const PRESETS_KEY = 'flock.layoutPresets';
function loadLayoutPresets(): LayoutPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? (JSON.parse(raw) as LayoutPreset[]) : [];
  } catch {
    return [];
  }
}
function saveLayoutPresets(p: LayoutPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

const HOST_SCOPE_KEY = 'flock.hostScope';
function loadHostScope(): HostScope {
  try {
    const raw = localStorage.getItem(HOST_SCOPE_KEY);
    if (!raw) return 'all';
    const v = JSON.parse(raw) as HostScope;
    if (v === 'all') return 'all';
    if (v && typeof v === 'object' && 'nodeId' in v && typeof v.nodeId === 'string') return v;
    if (v && typeof v === 'object' && 'pool' in v && typeof v.pool === 'string') return v;
    return 'all';
  } catch {
    return 'all';
  }
}
function saveHostScope(scope: HostScope): void {
  try {
    localStorage.setItem(HOST_SCOPE_KEY, JSON.stringify(scope));
  } catch {
    /* storage unavailable */
  }
}

const FOLLOW_KEY = 'flock.fleetSelectionFollow';
function loadFollow(): boolean {
  try {
    const v = localStorage.getItem(FOLLOW_KEY);
    return v !== '0'; // default on
  } catch {
    return true;
  }
}
function saveFollow(v: boolean): void {
  try {
    localStorage.setItem(FOLLOW_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

const ASSIST_KEY = 'flock.assistivePanels';
function loadAssistive(): boolean {
  try {
    return localStorage.getItem(ASSIST_KEY) === '1'; // default off (D5)
  } catch {
    return false;
  }
}
function saveAssistive(v: boolean): void {
  try {
    localStorage.setItem(ASSIST_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export interface PaddockUiState {
  view: PaddockView;
  settingsSection: SettingsSection;
  selectedSessionId: string | null;
  /**
   * Active project for stage layout / grid scope (herdr "space").
   * When a session is selected the stage scopes to that session's project.
   */
  selectedProjectId: string | null;

  /** Fleet supervision scope (D1 default all). */
  hostScope: HostScope;
  /** Paddock | Agents lens. */
  lens: ShellLens;
  /** stage = terminal-first (D5 default); tools = right panel open. */
  chrome: ShellChrome;
  /** Multi-device selection follow (per-user, client preference). */
  fleetSelectionFollow: boolean;
  /** Opt-in adaptive right-panel hijack (default off). */
  assistivePanels: boolean;

  sessionOrder: SessionOrder;
  nodeOrder: string[];
  penProjectId: string | null;
  penSessionIds: string[];
  penGroups: PenSummary[];
  activePenId: string | null;
  penActionHandler: ((action: PenAction) => void) | null;
  dialog: DialogKind;
  dialogNodeId: string | null;
  dialogProjectId: string | null;
  dialogSessionId: string | null;

  sidebarCollapsed: boolean;
  gridLayout: GridLayout;
  layoutPresets: LayoutPreset[];
  reviewedSessions: string[];
  fleetMode: FleetMode;
  race: ActiveRace | null;

  rightTab: RightTab;
  rightOpen: boolean;

  diffSelectedPath: string | null;
  diffSelectedStaged: boolean | null;
  viewerFile: string | null;
  terminalInput: ((text: string) => void) | null;
  nodeInfoNodeId: string | null;

  /** Zoomed leaf id for project layout (null = show full layout). */
  zoomLeafId: string | null;

  selectSession: (id: string | null) => void;
  /**
   * Open an agent on the stage (D2): selection + agents lens + stage chrome.
   * Replaces the old focusSession dual-mode.
   */
  openAgent: (id: string, projectId?: string | null) => void;
  /** Scope stage to a project (multi-leaf layout / project grid). */
  selectProject: (id: string | null) => void;
  setHostScope: (scope: HostScope) => void;
  setLens: (lens: ShellLens) => void;
  setChrome: (chrome: ShellChrome) => void;
  openTools: (tab?: RightTab) => void;
  closeTools: () => void;
  setFleetSelectionFollow: (v: boolean) => void;
  setAssistivePanels: (v: boolean) => void;
  setZoomLeafId: (id: string | null) => void;

  setSessionOrder: (projectId: string, orderedIds: string[]) => void;
  setNodeOrder: (orderedIds: string[]) => void;
  setPenState: (projectId: string | null, groups: PenSummary[], activePenId: string | null) => void;
  setPenActionHandler: (handler: ((action: PenAction) => void) | null) => void;
  requestPenAction: (action: PenAction) => void;
  saveLayoutPreset: (name: string, projectId: string, order: string[]) => void;
  applyLayoutPreset: (id: string) => void;
  deleteLayoutPreset: (id: string) => void;
  setReviewed: (id: string, reviewed: boolean) => void;
  setFleetMode: (m: FleetMode) => void;
  setRace: (race: ActiveRace) => void;
  endRace: () => void;
  openNodeInfo: (nodeId: string) => void;
  closeNodeInfo: () => void;
  toggleSidebar: () => void;
  toggleGridLayout: () => void;
  openRight: (tab: RightTab) => void;
  toggleRight: () => void;
  selectDiffFile: (path: string | null, staged?: boolean | null) => void;
  openFileInViewer: (path: string) => void;
  closeFileViewer: () => void;
  setTerminalInput: (fn: ((text: string) => void) | null) => void;
  /** Paddock lens (preserves selection). */
  openMission: () => void;
  openSettings: (section?: SettingsSection) => void;
  setSettingsSection: (section: SettingsSection) => void;
  closeSettings: () => void;
  openDialog: (
    kind: Exclude<DialogKind, null>,
    ctx?: { nodeId?: string; projectId?: string; sessionId?: string },
  ) => void;
  closeDialog: () => void;
}

export const usePaddock = create<PaddockUiState>((set) => ({
  // D1: land on mission control conceptually; path `/` sets overview + mission.
  view: 'overview',
  settingsSection: 'appearance',
  selectedSessionId: null,
  selectedProjectId: null,
  hostScope: loadHostScope(),
  lens: 'mission',
  chrome: 'stage',
  fleetSelectionFollow: loadFollow(),
  assistivePanels: loadAssistive(),
  dialog: null,
  dialogNodeId: null,
  dialogProjectId: null,
  dialogSessionId: null,

  sidebarCollapsed: loadSidebarCollapsed(),
  gridLayout: loadGridLayout(),
  layoutPresets: loadLayoutPresets(),
  reviewedSessions: loadReviewed(),
  fleetMode: loadFleetMode(),
  race: null,
  rightTab: 'chat',
  // D5: tools closed by default (terminal-first stage)
  rightOpen: false,
  diffSelectedPath: null,
  diffSelectedStaged: null,
  viewerFile: null,
  terminalInput: null,
  nodeInfoNodeId: null,
  zoomLeafId: null,
  sessionOrder: loadSessionOrder(),
  nodeOrder: loadNodeOrder(),
  penProjectId: null,
  penSessionIds: [],
  penGroups: [],
  activePenId: null,
  penActionHandler: null,

  selectSession: (id) =>
    set({
      selectedSessionId: id,
      selectedProjectId: null,
      diffSelectedPath: null,
      viewerFile: null,
      nodeInfoNodeId: null,
    }),

  openAgent: (id, projectId = null) =>
    set({
      selectedSessionId: id,
      selectedProjectId: projectId,
      diffSelectedPath: null,
      viewerFile: null,
      nodeInfoNodeId: null,
      lens: 'agents',
      chrome: 'stage',
      rightOpen: false,
      view: 'paddock',
      zoomLeafId: null,
    }),

  selectProject: (id) =>
    set({
      selectedProjectId: id,
      selectedSessionId: null,
      nodeInfoNodeId: null,
      view: 'paddock',
      lens: 'agents',
      chrome: 'stage',
      rightOpen: false,
      diffSelectedPath: null,
      viewerFile: null,
      zoomLeafId: null,
    }),

  setHostScope: (scope) => {
    saveHostScope(scope);
    set({ hostScope: scope });
  },
  setLens: (lens) =>
    set({
      lens,
      view: lens === 'mission' && !usePaddock.getState().selectedSessionId ? 'overview' : 'paddock',
    }),
  setChrome: (chrome) =>
    set({
      chrome,
      rightOpen: chrome === 'tools',
    }),
  openTools: (tab) =>
    set((s) => ({
      chrome: 'tools',
      rightOpen: true,
      rightTab: tab ?? s.rightTab,
    })),
  closeTools: () => set({ chrome: 'stage', rightOpen: false }),
  setFleetSelectionFollow: (v) => {
    saveFollow(v);
    set({ fleetSelectionFollow: v });
  },
  setAssistivePanels: (v) => {
    saveAssistive(v);
    set({ assistivePanels: v });
  },
  setZoomLeafId: (id) => set({ zoomLeafId: id }),

  setSessionOrder: (projectId, orderedIds) =>
    set((s) => {
      const next = { ...s.sessionOrder, [projectId]: orderedIds };
      saveSessionOrder(next);
      return { sessionOrder: next };
    }),
  setNodeOrder: (orderedIds) =>
    set(() => {
      saveNodeOrder(orderedIds);
      return { nodeOrder: orderedIds };
    }),
  setPenState: (projectId, groups, activePenId) => {
    const active = groups.find((pen) => pen.id === activePenId);
    set({
      penProjectId: projectId,
      penGroups: groups,
      activePenId,
      penSessionIds: active?.sessionIds ?? [],
    });
  },
  setPenActionHandler: (handler) => set({ penActionHandler: handler }),
  requestPenAction: (action) => usePaddock.getState().penActionHandler?.(action),
  saveLayoutPreset: (name, projectId, order) =>
    set((s) => {
      const preset: LayoutPreset = {
        id: crypto.randomUUID(),
        name,
        projectId,
        gridLayout: s.gridLayout,
        order,
      };
      const next = [
        ...s.layoutPresets.filter((p) => !(p.projectId === projectId && p.name === name)),
        preset,
      ];
      saveLayoutPresets(next);
      return { layoutPresets: next };
    }),
  applyLayoutPreset: (id) =>
    set((s) => {
      const p = s.layoutPresets.find((x) => x.id === id);
      if (!p) return {};
      saveGridLayout(p.gridLayout);
      const order = { ...s.sessionOrder, [p.projectId]: p.order };
      saveSessionOrder(order);
      return { gridLayout: p.gridLayout, sessionOrder: order };
    }),
  deleteLayoutPreset: (id) =>
    set((s) => {
      const next = s.layoutPresets.filter((x) => x.id !== id);
      saveLayoutPresets(next);
      return { layoutPresets: next };
    }),
  setReviewed: (id, reviewed) =>
    set((s) => {
      const next = reviewed
        ? [...new Set([...s.reviewedSessions, id])]
        : s.reviewedSessions.filter((x) => x !== id);
      saveReviewed(next);
      return { reviewedSessions: next };
    }),
  setFleetMode: (m) => {
    saveFleetMode(m);
    set({ fleetMode: m });
  },
  setRace: (race) => set({ race, dialog: null }),
  endRace: () => set({ race: null }),
  openNodeInfo: (nodeId) =>
    set({
      nodeInfoNodeId: nodeId,
      view: 'paddock',
      hostScope: { nodeId },
    }),
  closeNodeInfo: () => set({ nodeInfoNodeId: null }),
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed;
      saveSidebarCollapsed(v);
      return { sidebarCollapsed: v };
    }),
  toggleGridLayout: () =>
    set((s) => {
      const v: GridLayout = s.gridLayout === 'columns' ? 'grid' : 'columns';
      saveGridLayout(v);
      return { gridLayout: v };
    }),
  openRight: (tab) => set({ rightTab: tab, rightOpen: true, chrome: 'tools' }),
  toggleRight: () =>
    set((s) => {
      const open = !s.rightOpen;
      return { rightOpen: open, chrome: open ? 'tools' : 'stage' };
    }),
  selectDiffFile: (path, staged = null) =>
    set({ diffSelectedPath: path, diffSelectedStaged: path === null ? null : staged }),
  openFileInViewer: (path) =>
    set({ viewerFile: path, rightTab: 'files', rightOpen: true, chrome: 'tools' }),
  closeFileViewer: () => set({ viewerFile: null }),
  setTerminalInput: (fn) => set({ terminalInput: fn }),

  openMission: () =>
    set({
      view: 'overview',
      lens: 'mission',
      nodeInfoNodeId: null,
      // preserve selectedSessionId / selectedProjectId (plan §3.3)
    }),

  openSettings: (section) =>
    set((s) => ({ view: 'settings', settingsSection: section ?? s.settingsSection })),
  setSettingsSection: (section) => set({ settingsSection: section }),
  closeSettings: () => set({ view: 'paddock' }),
  openDialog: (kind, ctx) =>
    set({
      dialog: kind,
      dialogNodeId: ctx?.nodeId ?? null,
      dialogProjectId: ctx?.projectId ?? null,
      dialogSessionId: ctx?.sessionId ?? null,
    }),
  closeDialog: () => set({ dialog: null }),
}));
