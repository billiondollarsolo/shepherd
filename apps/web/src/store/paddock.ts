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
  gridLayout: GridLayout;
  layoutPresets: LayoutPreset[];
  race: ActiveRace | null;

  rightTab: RightTab;
  rightOpen: boolean;
  projectView: 'agents' | 'git';

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
  toggleGridLayout: () => void;
  openRight: (tab: RightTab) => void;
  openProjectGit: (projectId: string) => void;
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
