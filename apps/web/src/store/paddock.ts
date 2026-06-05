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
export type PaddockView = 'paddock' | 'settings';

/**
 * Which dialog is open (null = none). Settings is a view, not a dialog.
 * `terminate-session` is a destructive-action CONFIRM (not a create dialog).
 */
export type DialogKind = 'node' | 'project' | 'session' | 'terminate-session' | null;

/** A settings page section (inner-sidebar item). Extend as settings grow. */
export type SettingsSection = 'appearance' | 'notifications' | 'nodes' | 'account' | 'about';

/** Which view the right-hand session panel shows (Codex-style side panel). */
export type RightTab = 'activity' | 'browser' | 'diff' | 'files' | 'search';

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

  /** How the grid tiles 2+ sessions: full-height 'columns' or 2-wide 'grid'. Persisted. */
  gridLayout: GridLayout;

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
  /** Open the node-info dialog for a node. */
  openNodeInfo: (nodeId: string) => void;
  /** Close the node-info dialog. */
  closeNodeInfo: () => void;
  /** Collapse/expand the left sidebar to an icon rail. */
  toggleSidebar: () => void;
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
  gridLayout: loadGridLayout(),
  rightTab: 'activity',
  rightOpen: true,
  diffSelectedPath: null,
  diffSelectedStaged: null,
  viewerFile: null,
  terminalInput: null,

  nodeInfoNodeId: null,
  sessionOrder: loadSessionOrder(),

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
  // Node details fill the CENTER pane (sidebar + bottom bar stay); not a takeover.
  openNodeInfo: (nodeId) => set({ nodeInfoNodeId: nodeId, view: 'paddock' }),
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
  setViewMode: (mode) => set({ viewMode: mode }),
  openRight: (tab) => set({ rightTab: tab, rightOpen: true }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  selectDiffFile: (path, staged = null) =>
    set({ diffSelectedPath: path, diffSelectedStaged: path === null ? null : staged }),
  openFileInViewer: (path) => set({ viewerFile: path, rightTab: 'files', rightOpen: true }),
  closeFileViewer: () => set({ viewerFile: null }),
  setTerminalInput: (fn) => set({ terminalInput: fn }),
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
