/**
 * Paddock UI store (zustand) — UI-only state: which top-level view is showing,
 * the current session selection, the active settings section, and which create
 * dialog is open (plus its context).
 *
 * Server data (nodes/projects/sessions) and all mutations now live in TanStack
 * Query (`../data/queries`); this store deliberately holds NO server data, so
 * there is a single source of truth for it (the Query cache).
 */
import { create } from 'zustand';

/** Top-level surface. Settings is a full PAGE (not a modal) so it can grow. */
export type PaddockView = 'paddock' | 'settings' | 'overview';

/**
 * Which dialog is open (null = none). Settings is a view, not a dialog.
 * `terminate-session` is a destructive-action CONFIRM (not a create dialog).
 */
export type DialogKind = 'node' | 'project' | 'session' | 'terminate-session' | 'config' | 'race' | null;

/** An active compare/race: the shared task + the racer session ids being compared. */
export interface ActiveRace {
  task: string;
  sessionIds: string[];
}

/** A settings page section (inner-sidebar item). Extend as settings grow. */
export type SettingsSection = 'appearance' | 'notifications' | 'nodes' | 'account' | 'about';

/** Which view the right-hand session panel shows (Codex-style side panel). */
export type RightTab = 'chat' | 'activity' | 'browser' | 'diff' | 'files' | 'search';

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
    /* storage unavailable (private mode / quota) — order is just not persisted */
  }
}

/** User's manual node order (ids) for the sidebar — LOCKED, never auto-changes. */
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
    /* storage unavailable — order is just not persisted */
  }
}

/**
 * Apply the locked node order: saved-order ids first (in their saved position),
 * then any not-yet-ordered nodes appended in a STABLE, deterministic order (by
 * name) so the list never jumps around — even before the user drags anything.
 */
export function orderNodes<T extends { id: string; name: string }>(nodes: T[], order: string[]): T[] {
  const idx = new Map(order.map((id, i) => [id, i]));
  return [...nodes].sort((a, b) => {
    const ai = idx.has(a.id) ? (idx.get(a.id) as number) : Number.POSITIVE_INFINITY;
    const bi = idx.has(b.id) ? (idx.get(b.id) as number) : Number.POSITIVE_INFINITY;
    return ai !== bi ? ai - bi : a.name.localeCompare(b.name);
  });
}

/** Left sidebar collapsed-to-rail preference, persisted in localStorage. */
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
    /* storage unavailable — preference is just not persisted */
  }
}

/**
 * How the multi-agent grid tiles 2+ sessions, persisted in localStorage:
 *  - 'columns' — full-height columns side-by-side, horizontal scroll past a few
 *    (best for watching agents work; the default).
 *  - 'grid' — fixed 2-wide, vertical scroll (denser for many sessions).
 */
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
    /* storage unavailable — preference is just not persisted */
  }
}

/** How the dev chooses to view/drive the fleet (the overview "lens"), persisted:
 *  - 'command' — dense Command-Center dashboard (default)
 *  - 'terminal' — Warp-style command-bar + output blocks
 *  - 'spatial'  — the orchestration graph as a canvas */
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
    /* storage unavailable — preference just isn't persisted */
  }
}

/** Per-session "I've reviewed this agent's work" markers (ids). Closes the
 *  Ready-to-review → Reviewed loop. Persisted in localStorage (a personal marker). */
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
    /* storage unavailable — markers just aren't persisted */
  }
}


/** A saved grid arrangement ("Backend trio") — the grid layout + the per-project
 *  session order, recalled in one click. Persisted in localStorage. */
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
    /* storage unavailable — presets just aren't persisted */
  }
}

export interface PaddockUiState {
  view: PaddockView;
  settingsSection: SettingsSection;
  selectedSessionId: string | null;
  /**
   * The project the grid is scoped to when NO session is selected (chosen via the
   * sidebar / a `/p/:id` URL). When a session IS selected the grid scopes to that
   * session's project instead, so selecting a session clears this. Backs the
   * `/p/:projectId` route.
   */
  selectedProjectId: string | null;
  /**
   * User's manual session order per project (drag-to-reorder from the tabs or the
   * sidebar). The grid panes, top tabs, and sidebar all sort by this; sessions not
   * listed (newly created) fall to the end by creation time. Persisted per-browser.
   */
  sessionOrder: SessionOrder;
  /** User's manual node order (ids) for the sidebar. LOCKED — nodes never reorder
   *  themselves; only drag-to-reorder changes this. Persisted per-browser. */
  nodeOrder: string[];
  dialog: DialogKind;
  /** Context for the add-project / add-session / terminate dialogs. */
  dialogNodeId: string | null;
  dialogProjectId: string | null;
  dialogSessionId: string | null;

  /**
   * Center view mode. `grid` (the DEFAULT) tiles the current project's sessions
   * side-by-side in a resizable layout — the hive model: every terminal is a real
   * session, so the grid is derived from the project's sessions (no separate pane
   * list). `focus` MAXIMIZES one session (its terminal + right panel). The sidebar
   * is the only roster — there is no tab bar.
   */
  viewMode: 'focus' | 'grid';

  /** Left sidebar collapsed to an icon-only rail (hover tooltips). Persisted. */
  sidebarCollapsed: boolean;

  /** Immersive "zen" mode: hide the sidebar + bottom bar + right panel so a single
   *  agent fills the screen for distraction-free deep work. Transient (not persisted). */
  zenMode: boolean;

  /** How the grid tiles 2+ sessions: full-height 'columns' or 2-wide 'grid'. Persisted. */
  gridLayout: GridLayout;

  /** Saved grid arrangements (name + layout + session order), recalled in one click. */
  layoutPresets: LayoutPreset[];

  /** Session ids the user has marked reviewed (drops them from "Ready to review"). */
  reviewedSessions: string[];

  /** The dev's chosen fleet/overview lens (Command Center / Terminal / Spatial). */
  fleetMode: FleetMode;

  /** The active compare/race (the racers being compared), or null. Transient. */
  race: ActiveRace | null;

  /** Right session panel: which tab + whether it's open (resizable, collapsible). */
  rightTab: RightTab;
  rightOpen: boolean;

  /**
   * The file the Source Control panel is previewing (null = the file list).
   * `staged` picks which side's diff to show (null = combined). Shared in the
   * store so the Activity "Files" artifact can deep-link into a file preview.
   */
  diffSelectedPath: string | null;
  diffSelectedStaged: boolean | null;

  /**
   * Absolute path of a file to preview in the Files viewer (null = the tree).
   * Shared in the store so Find-in-Files results can deep-link a file open.
   */
  viewerFile: string | null;

  /**
   * Writer into the ACTIVE session's terminal PTY (registered by the focused
   * Terminal on mount). Lets the file tree / drag-and-drop insert a path or a
   * command into the live terminal. Null when no terminal is mounted.
   */
  terminalInput: ((text: string) => void) | null;

  /** The node whose details fill the center pane (null = show the session pane). */
  nodeInfoNodeId: string | null;

  /** Highlight a session WITHOUT changing the view mode (e.g. the grid tab strip
   *  scrolls to a pane but stays in grid). */
  selectSession: (id: string | null) => void;
  /** Select a session AND maximize it (focus view). What "open this session"
   *  should do from the sidebar / a grid cell — a grid of one is pointless. */
  focusSession: (id: string) => void;
  /** Scope the grid to a project with nothing focused (sidebar / `/p/:id`). */
  selectProject: (id: string | null) => void;
  /** Set a project's manual session order (the full ordered id list). */
  setSessionOrder: (projectId: string, orderedIds: string[]) => void;
  /** Set the sidebar node order (the full ordered id list) — drag-to-reorder. */
  setNodeOrder: (orderedIds: string[]) => void;
  /** Save the current grid layout + a project's session order as a named preset. */
  saveLayoutPreset: (name: string, projectId: string, order: string[]) => void;
  /** Apply a saved preset: restore its grid layout + the project's session order. */
  applyLayoutPreset: (id: string) => void;
  /** Delete a saved layout preset. */
  deleteLayoutPreset: (id: string) => void;
  /** Mark / unmark a session as reviewed (toggles it out of "Ready to review"). */
  setReviewed: (id: string, reviewed: boolean) => void;
  /** Switch the fleet/overview lens (⌘1/2/3), persisted. */
  setFleetMode: (m: FleetMode) => void;
  /** Start comparing a set of racer sessions (opens the compare view). */
  setRace: (race: ActiveRace) => void;
  /** Dismiss the compare view (does not kill the racers). */
  endRace: () => void;
  /** Open the node-info dialog for a node. */
  openNodeInfo: (nodeId: string) => void;
  /** Close the node-info dialog. */
  closeNodeInfo: () => void;
  /** Collapse/expand the left sidebar to an icon rail. */
  toggleSidebar: () => void;
  /** Toggle immersive zen mode (entering also collapses the right panel). */
  toggleZen: () => void;
  /** Set zen mode explicitly (e.g. Escape to exit). */
  setZen: (v: boolean) => void;
  /** Switch the grid between full-height columns and the 2-wide grid. */
  toggleGridLayout: () => void;
  /** Switch the center between the focus view and the multi-agent grid. */
  setViewMode: (mode: 'focus' | 'grid') => void;
  /** Show a right-panel tab (opens the panel). */
  openRight: (tab: RightTab) => void;
  /** Collapse/expand the right panel. */
  toggleRight: () => void;
  /** Select a file for the Source Control diff preview (null clears it). */
  selectDiffFile: (path: string | null, staged?: boolean | null) => void;
  /** Open a file in the Files viewer (switches to the Files tab). */
  openFileInViewer: (path: string) => void;
  /** Close the Files viewer (back to the tree). */
  closeFileViewer: () => void;
  /** Register/clear the active terminal's PTY input writer. */
  setTerminalInput: (fn: ((text: string) => void) | null) => void;
  openOverview: () => void;
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
  view: 'paddock',
  settingsSection: 'appearance',
  selectedSessionId: null,
  selectedProjectId: null,
  dialog: null,
  dialogNodeId: null,
  dialogProjectId: null,
  dialogSessionId: null,

  viewMode: 'grid',

  sidebarCollapsed: loadSidebarCollapsed(),
  zenMode: false,
  gridLayout: loadGridLayout(),
  layoutPresets: loadLayoutPresets(),
  reviewedSessions: loadReviewed(),
  fleetMode: loadFleetMode(),
  race: null,
  rightTab: 'chat',
  rightOpen: true,
  diffSelectedPath: null,
  diffSelectedStaged: null,
  viewerFile: null,
  terminalInput: null,

  nodeInfoNodeId: null,
  sessionOrder: loadSessionOrder(),
  nodeOrder: loadNodeOrder(),

  // Changing the selected session clears any open file preview AND leaves the
  // node view (selecting a session shows that session in the center).
  selectSession: (id) =>
    set({
      selectedSessionId: id,
      // The selected session's own project now scopes the grid.
      selectedProjectId: null,
      diffSelectedPath: null,
      viewerFile: null,
      nodeInfoNodeId: null,
    }),
  // "Open this session" — select it AND maximize it. A grid of one is pointless,
  // so opening a session from the sidebar should land in the focused view (Header
  // + terminal + side panel), not a single-tab grid.
  focusSession: (id) =>
    set({
      selectedSessionId: id,
      selectedProjectId: null,
      diffSelectedPath: null,
      viewerFile: null,
      nodeInfoNodeId: null,
      viewMode: 'focus',
      view: 'paddock',
    }),
  // Scope the grid to a project with nothing focused (back to the side-by-side
  // view of that project). Used by `/p/:id` and project rows in the sidebar.
  selectProject: (id) =>
    set({
      selectedProjectId: id,
      selectedSessionId: null,
      viewMode: 'grid',
      nodeInfoNodeId: null,
      view: 'paddock',
      diffSelectedPath: null,
      viewerFile: null,
    }),
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
  saveLayoutPreset: (name, projectId, order) =>
    set((s) => {
      const preset: LayoutPreset = { id: crypto.randomUUID(), name, projectId, gridLayout: s.gridLayout, order };
      // Replace any same-name preset for this project (idempotent re-save).
      const next = [...s.layoutPresets.filter((p) => !(p.projectId === projectId && p.name === name)), preset];
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
  // Node details fill the CENTER pane (sidebar + bottom bar stay); not a takeover.
  openNodeInfo: (nodeId) => set({ nodeInfoNodeId: nodeId, view: 'paddock' }),
  closeNodeInfo: () => set({ nodeInfoNodeId: null }),
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed;
      saveSidebarCollapsed(v);
      return { sidebarCollapsed: v };
    }),
  // Entering zen also collapses the right panel for max immersion; exiting leaves it.
  toggleZen: () => set((s) => (s.zenMode ? { zenMode: false } : { zenMode: true, rightOpen: false })),
  setZen: (v) => set({ zenMode: v }),
  toggleGridLayout: () =>
    set((s) => {
      const v: GridLayout = s.gridLayout === 'columns' ? 'grid' : 'columns';
      saveGridLayout(v);
      return { gridLayout: v };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),
  openRight: (tab) => set({ rightTab: tab, rightOpen: true }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  selectDiffFile: (path, staged = null) =>
    set({ diffSelectedPath: path, diffSelectedStaged: path === null ? null : staged }),
  openFileInViewer: (path) => set({ viewerFile: path, rightTab: 'files', rightOpen: true }),
  closeFileViewer: () => set({ viewerFile: null }),
  setTerminalInput: (fn) => set({ terminalInput: fn }),
  openOverview: () =>
    set({ view: 'overview', selectedSessionId: null, selectedProjectId: null, nodeInfoNodeId: null }),
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
