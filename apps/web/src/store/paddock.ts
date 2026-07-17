/**
 * Paddock UI store (zustand) — UI-only state for the herdr-aligned shell.
 *
 * Shell model:
 *   lens (mission|agents) · chrome (stage|tools) · selection
 * No dual focus/zen modes — stage is always the drive surface; tools are opt-in.
 *
 * Server data lives in TanStack Query; this store holds NO server data.
 */
import { create } from 'zustand';
import type {
  GridLayout,
  SavedLayoutPreset,
  ShellChrome,
  ShellLens,
  UserPreferencesDocument,
} from '@flock/shared';
export type { GridLayout } from '@flock/shared';

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
export type SettingsSection =
  | 'appearance'
  | 'notifications'
  | 'nodes'
  | 'account'
  | 'operations'
  | 'deployment-preview'
  | 'audit'
  | 'about';

/** Which view the right-hand session panel shows (Codex-style side panel). */
export type RightTab = 'chat' | 'activity' | 'diff' | 'files' | 'search' | 'notes';

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

/** Per-project user-defined session order (ids), persisted by DurablePreferencesSync. */
export type SessionOrder = Record<string, string[]>;

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

// ── Sidebar ARIA-tree model (task 7.3) ──────────────────────────────────────
// Pure, DOM-free helpers so the expand/collapse persistence and the keyboard
// traversal model unit-test without jsdom.

/**
 * Resolve a tree branch's expanded state. An explicit persisted override always
 * wins; with no override the branch is SEEDED open when it needs attention
 * (FR-UI3 — an awaiting/errored branch reveals itself), otherwise it falls back
 * to `defaultOpen` (the sidebar keeps its historic all-open default).
 */
export function resolveTreeExpanded(
  override: boolean | undefined,
  needsAttention: boolean,
  defaultOpen = true,
): boolean {
  if (override !== undefined) return override;
  return needsAttention ? true : defaultOpen;
}

/** One visible row of the flattened tree, in top-to-bottom (DOM) order. */
export interface TreeRow {
  readonly id: string;
  /** 1 = node, 2 = project, 3 = session. */
  readonly level: number;
  /** A branch (has an aria-expanded state); leaves are false. */
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** What a key press resolves to against the visible tree (interpreted by the view). */
export type TreeKeyAction =
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'expand'; readonly id: string }
  | { readonly kind: 'collapse'; readonly id: string }
  | { readonly kind: 'activate'; readonly id: string };

/**
 * The WAI-ARIA `tree` traversal model (roving tabindex): Up/Down move between
 * visible rows; Right expands (or steps into the first child); Left collapses
 * (or steps out to the parent); Enter/Space activate; Home/End jump to the ends.
 * Pure — returns the intent; the caller focuses/toggles/opens accordingly.
 */
export function treeKeydownAction(
  rows: readonly TreeRow[],
  currentId: string,
  key: string,
): TreeKeyAction | null {
  const index = rows.findIndex((r) => r.id === currentId);
  if (index < 0) return null;
  const row = rows[index]!;
  switch (key) {
    case 'ArrowDown': {
      const next = rows[index + 1];
      return next ? { kind: 'focus', id: next.id } : null;
    }
    case 'ArrowUp': {
      const prev = rows[index - 1];
      return prev ? { kind: 'focus', id: prev.id } : null;
    }
    case 'Home':
      return rows.length > 0 ? { kind: 'focus', id: rows[0]!.id } : null;
    case 'End':
      return rows.length > 0 ? { kind: 'focus', id: rows[rows.length - 1]!.id } : null;
    case 'ArrowRight': {
      if (row.expandable && !row.expanded) return { kind: 'expand', id: row.id };
      if (row.expandable && row.expanded) {
        const next = rows[index + 1];
        // Only step IN when the next visible row is actually a child (deeper).
        return next && next.level > row.level ? { kind: 'focus', id: next.id } : null;
      }
      return null;
    }
    case 'ArrowLeft': {
      if (row.expandable && row.expanded) return { kind: 'collapse', id: row.id };
      // Otherwise move OUT to the parent: nearest previous shallower row.
      for (let i = index - 1; i >= 0; i -= 1) {
        if (rows[i]!.level < row.level) return { kind: 'focus', id: rows[i]!.id };
      }
      return null;
    }
    case 'Enter':
    case ' ':
      return { kind: 'activate', id: row.id };
    default:
      return null;
  }
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

// Persisted, user-draggable width of the left tree (px). A roomier default than
// the old fixed 252 so the sidebar breathes; clamped to a sensible drag range.
export const SIDEBAR_WIDTH_KEY = 'flock.sidebarWidth';
export const SIDEBAR_WIDTH_DEFAULT = 288;
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 460;
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
}
function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return raw == null ? SIDEBAR_WIDTH_DEFAULT : clampSidebarWidth(Number.parseInt(raw, 10));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}
function saveSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
  } catch {
    /* storage unavailable */
  }
}

// The session stage's main view: the raw terminal (the floor + where agents log
// in) or the structured chat interface. Remembered PER SESSION and persisted, so
// each session reopens on the view you last used; new sessions default to the
// terminal. `stageViewFor` is the pure default-aware selector.
export type StageView = 'terminal' | 'chat';
const STAGE_VIEW_KEY = 'flock.stageViews';
function loadStageViews(): Record<string, StageView> {
  try {
    const raw = localStorage.getItem(STAGE_VIEW_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, StageView> = {};
    for (const [id, v] of Object.entries(parsed)) if (v === 'chat' || v === 'terminal') out[id] = v;
    return out;
  } catch {
    return {};
  }
}
function saveStageViews(views: Record<string, StageView>): void {
  try {
    localStorage.setItem(STAGE_VIEW_KEY, JSON.stringify(views));
  } catch {
    /* storage unavailable */
  }
}
/** The remembered view for a session, defaulting to the terminal (login floor). */
export function stageViewFor(views: Record<string, StageView>, sessionId: string): StageView {
  return views[sessionId] ?? 'terminal';
}

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

export type LayoutPreset = SavedLayoutPreset;

// Persisted per-id sidebar expand/collapse overrides (task 7.3). Absence of an
// entry means "use the attention-seeded default" (see resolveTreeExpanded).
const TREE_EXPANDED_KEY = 'flock.treeExpanded';
function loadTreeExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TREE_EXPANDED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
    return {};
  } catch {
    return {};
  }
}
function saveTreeExpanded(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(TREE_EXPANDED_KEY, JSON.stringify(v));
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

  /** Paddock | Agents lens. */
  lens: ShellLens;
  /** stage = terminal-first (D5 default); tools = right panel open. */
  chrome: ShellChrome;
  /** Opt-in adaptive right-panel hijack (default off). */
  assistivePanels: boolean;

  sessionOrder: SessionOrder;
  nodeOrder: string[];
  preferencesRevision: number;
  preferencesHydrated: boolean;
  preferencesSaveState: 'loading' | 'saved' | 'saving' | 'retrying' | 'failed';
  preferencesError: string | null;
  preferencesRetryNonce: number;
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
  /** Persisted, user-draggable width of the left tree in px. */
  sidebarWidth: number;
  /** Per-session stage view (raw terminal | structured chat); default terminal. */
  stageViews: Record<string, StageView>;
  /** Persisted per-id sidebar tree expand/collapse overrides (task 7.3). */
  treeExpanded: Record<string, boolean>;
  gridLayout: GridLayout;
  layoutPresets: LayoutPreset[];
  race: ActiveRace | null;

  rightTab: RightTab;
  rightOpen: boolean;
  projectView: 'agents' | 'git' | 'ports';

  diffSelectedPath: string | null;
  diffSelectedStaged: boolean | null;
  viewerFile: string | null;
  terminalInput: ((text: string) => void) | null;
  /** Force the active terminal to reconnect (used after a relaunch swaps the PTY,
   *  which the terminal otherwise treats as a terminal 'exited' and won't reattach). */
  terminalReconnect: (() => void) | null;
  /** Per-session PTY input writers, keyed by session id. Every MOUNTED terminal
   *  registers here (not just the focused one), so a chat composer can type into its
   *  OWN agent even in the multi-agent grid — where the single `terminalInput` seam
   *  (focused cell only) can't. */
  sessionInputs: Record<string, (text: string) => void>;
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
  setLens: (lens: ShellLens) => void;
  setChrome: (chrome: ShellChrome) => void;
  openTools: (tab?: RightTab) => void;
  closeTools: () => void;
  setAssistivePanels: (v: boolean) => void;
  setZoomLeafId: (id: string | null) => void;

  setSessionOrder: (projectId: string, orderedIds: string[]) => void;
  setNodeOrder: (orderedIds: string[]) => void;
  hydrateDurablePreferences: (document: UserPreferencesDocument) => void;
  acknowledgeDurablePreferences: (revision: number) => void;
  setPreferencesSaveState: (
    state: PaddockUiState['preferencesSaveState'],
    error?: string | null,
  ) => void;
  retryPreferences: () => void;
  setPenState: (projectId: string | null, groups: PenSummary[], activePenId: string | null) => void;
  setPenActionHandler: (handler: ((action: PenAction) => void) | null) => void;
  requestPenAction: (action: PenAction) => void;
  saveLayoutPreset: (name: string, projectId: string, order: string[]) => void;
  applyLayoutPreset: (id: string) => void;
  deleteLayoutPreset: (id: string) => void;
  setRace: (race: ActiveRace) => void;
  endRace: () => void;
  openNodeInfo: (nodeId: string) => void;
  closeNodeInfo: () => void;
  toggleSidebar: () => void;
  /** Set the left tree width in px (clamped + persisted). */
  setSidebarWidth: (px: number) => void;
  /** Remember a session's stage view (persisted, per session). */
  setStageView: (sessionId: string, v: StageView) => void;
  /** Set a sidebar tree branch's expand/collapse override (persisted). */
  setTreeExpanded: (id: string, expanded: boolean) => void;
  toggleGridLayout: () => void;
  openRight: (tab: RightTab) => void;
  openProjectGit: (projectId: string) => void;
  openProjectPorts: (projectId: string) => void;
  toggleRight: () => void;
  selectDiffFile: (path: string | null, staged?: boolean | null) => void;
  openFileInViewer: (path: string) => void;
  closeFileViewer: () => void;
  setTerminalInput: (fn: ((text: string) => void) | null) => void;
  setTerminalReconnect: (fn: (() => void) | null) => void;
  registerSessionInput: (sessionId: string, fn: ((text: string) => void) | null) => void;
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
  // D1: land on the Paddock dashboard; path `/` sets overview + mission lens.
  view: 'overview',
  settingsSection: 'appearance',
  selectedSessionId: null,
  selectedProjectId: null,
  lens: 'mission',
  chrome: 'stage',
  assistivePanels: loadAssistive(),
  dialog: null,
  dialogNodeId: null,
  dialogProjectId: null,
  dialogSessionId: null,

  sidebarCollapsed: loadSidebarCollapsed(),
  sidebarWidth: loadSidebarWidth(),
  stageViews: loadStageViews(),
  treeExpanded: loadTreeExpanded(),
  gridLayout: loadGridLayout(),
  layoutPresets: [],
  race: null,
  rightTab: 'chat',
  // D5: tools closed by default (terminal-first stage)
  rightOpen: false,
  projectView: 'agents',
  diffSelectedPath: null,
  diffSelectedStaged: null,
  viewerFile: null,
  terminalInput: null,
  terminalReconnect: null,
  sessionInputs: {},
  nodeInfoNodeId: null,
  zoomLeafId: null,
  sessionOrder: {},
  nodeOrder: [],
  preferencesRevision: 0,
  preferencesHydrated: false,
  preferencesSaveState: 'loading',
  preferencesError: null,
  preferencesRetryNonce: 0,
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
      projectView: 'agents',
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
      projectView: 'agents',
      diffSelectedPath: null,
      viewerFile: null,
      zoomLeafId: null,
    }),

  setLens: (lens) =>
    set((s) => ({
      lens,
      view: lens === 'mission' ? 'overview' : 'paddock',
      // Returning to Agents restores the last Pen's project when Paddock has no
      // staged selection. This keeps workspace switching useful without letting
      // the old selection prevent Paddock from rendering.
      selectedProjectId:
        lens === 'agents' && !s.selectedSessionId
          ? (s.selectedProjectId ?? s.penProjectId)
          : s.selectedProjectId,
    })),
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
  setAssistivePanels: (v) => {
    saveAssistive(v);
    set({ assistivePanels: v });
  },
  setZoomLeafId: (id) => set({ zoomLeafId: id }),

  setSessionOrder: (projectId, orderedIds) =>
    set((s) => {
      const next = { ...s.sessionOrder, [projectId]: orderedIds };
      return { sessionOrder: next };
    }),
  setNodeOrder: (orderedIds) => set({ nodeOrder: orderedIds }),
  hydrateDurablePreferences: (document) =>
    set({
      nodeOrder: document.nodeOrder,
      sessionOrder: document.sessionOrder,
      layoutPresets: document.layoutPresets,
      preferencesRevision: document.revision,
      preferencesHydrated: true,
      preferencesSaveState: 'saved',
      preferencesError: null,
    }),
  acknowledgeDurablePreferences: (preferencesRevision) =>
    set({ preferencesRevision, preferencesSaveState: 'saved', preferencesError: null }),
  setPreferencesSaveState: (preferencesSaveState, preferencesError = null) =>
    set({ preferencesSaveState, preferencesError }),
  retryPreferences: () =>
    set((state) => ({ preferencesRetryNonce: state.preferencesRetryNonce + 1 })),
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
      return { layoutPresets: next };
    }),
  applyLayoutPreset: (id) =>
    set((s) => {
      const p = s.layoutPresets.find((x) => x.id === id);
      if (!p) return {};
      saveGridLayout(p.gridLayout);
      const order = { ...s.sessionOrder, [p.projectId]: p.order };
      return { gridLayout: p.gridLayout, sessionOrder: order };
    }),
  deleteLayoutPreset: (id) =>
    set((s) => {
      const next = s.layoutPresets.filter((x) => x.id !== id);
      return { layoutPresets: next };
    }),
  setRace: (race) => set({ race, dialog: null }),
  endRace: () => set({ race: null }),
  openNodeInfo: (nodeId) =>
    set({
      nodeInfoNodeId: nodeId,
      view: 'paddock',
    }),
  closeNodeInfo: () => set({ nodeInfoNodeId: null }),
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed;
      saveSidebarCollapsed(v);
      return { sidebarCollapsed: v };
    }),
  setSidebarWidth: (px) => {
    const width = clampSidebarWidth(px);
    saveSidebarWidth(width);
    set({ sidebarWidth: width });
  },
  setStageView: (sessionId, v) =>
    set((s) => {
      const stageViews = { ...s.stageViews, [sessionId]: v };
      saveStageViews(stageViews);
      return { stageViews };
    }),
  setTreeExpanded: (id, expanded) =>
    set((s) => {
      const next = { ...s.treeExpanded, [id]: expanded };
      saveTreeExpanded(next);
      return { treeExpanded: next };
    }),
  toggleGridLayout: () =>
    set((s) => {
      const v: GridLayout = s.gridLayout === 'columns' ? 'grid' : 'columns';
      saveGridLayout(v);
      return { gridLayout: v };
    }),
  openRight: (tab) => set({ rightTab: tab, rightOpen: true, chrome: 'tools' }),
  openProjectGit: (projectId) =>
    set({
      selectedSessionId: null,
      selectedProjectId: projectId,
      nodeInfoNodeId: null,
      lens: 'agents',
      view: 'paddock',
      projectView: 'git',
      rightOpen: false,
      chrome: 'stage',
      zoomLeafId: null,
    }),
  openProjectPorts: (projectId) =>
    set({
      selectedSessionId: null,
      selectedProjectId: projectId,
      nodeInfoNodeId: null,
      lens: 'agents',
      view: 'paddock',
      projectView: 'ports',
      rightOpen: false,
      chrome: 'stage',
      zoomLeafId: null,
    }),
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
  setTerminalReconnect: (fn) => set({ terminalReconnect: fn }),
  registerSessionInput: (sessionId, fn) =>
    set((s) => {
      const next = { ...s.sessionInputs };
      if (fn) next[sessionId] = fn;
      else delete next[sessionId];
      return { sessionInputs: next };
    }),

  openMission: () => {
    set({
      view: 'overview',
      lens: 'mission',
      nodeInfoNodeId: null,
      selectedSessionId: null,
      selectedProjectId: null,
      projectView: 'agents',
      zoomLeafId: null,
    });
  },

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
