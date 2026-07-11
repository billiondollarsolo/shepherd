/**
 * Shell navigation state machine — herdr-aligned paddock model.
 *
 * Single shell: lens + selection + chrome. No dual focus/zen modes.
 */
import { z } from 'zod';

export const ShellLensEnum = z.enum(['mission', 'agents']);
export type ShellLens = z.infer<typeof ShellLensEnum>;

export const ShellChromeEnum = z.enum(['stage', 'tools']);
export type ShellChrome = z.infer<typeof ShellChromeEnum>;

/** Canonical shell navigation state (URL + store subset). */
export interface ShellNavState {
  lens: ShellLens;
  /** Terminal-first stage vs tools open (D5: default stage). */
  chrome: ShellChrome;
  selectedSessionId: string | null;
  activeProjectId: string | null;
  nodeInfoNodeId: string | null;
  /** Settings is a full page, not a lens. */
  settings: boolean;
  settingsSection: string;
}

export const DEFAULT_SHELL_NAV: ShellNavState = {
  lens: 'mission',
  chrome: 'stage',
  selectedSessionId: null,
  activeProjectId: null,
  nodeInfoNodeId: null,
  settings: false,
  settingsSection: 'appearance',
};

export interface OpenAgentOpts {
  sessionId: string;
  projectId: string;
}

/** D2: open agent → selection + agents lens + stage chrome. */
export function openAgent(state: ShellNavState, opts: OpenAgentOpts): ShellNavState {
  return {
    ...state,
    settings: false,
    nodeInfoNodeId: null,
    selectedSessionId: opts.sessionId,
    activeProjectId: opts.projectId,
    lens: 'agents',
    chrome: 'stage',
  };
}

/** D1 home: Mission Control, all hosts — preserves selection/stage. */
export function openMission(state: ShellNavState): ShellNavState {
  return {
    ...state,
    settings: false,
    nodeInfoNodeId: null,
    lens: 'mission',
    // do NOT clear selectedSessionId / activeProjectId
  };
}

export function setLens(state: ShellNavState, lens: ShellLens): ShellNavState {
  return { ...state, settings: false, lens };
}

export function setChrome(state: ShellNavState, chrome: ShellChrome): ShellNavState {
  return { ...state, chrome };
}

export function openTools(state: ShellNavState): ShellNavState {
  return setChrome(state, 'tools');
}

export function closeTools(state: ShellNavState): ShellNavState {
  return setChrome(state, 'stage');
}

export function selectProject(state: ShellNavState, projectId: string | null): ShellNavState {
  return {
    ...state,
    settings: false,
    nodeInfoNodeId: null,
    activeProjectId: projectId,
    selectedSessionId: null,
    lens: 'agents',
    chrome: 'stage',
  };
}

export function clearSelection(state: ShellNavState): ShellNavState {
  return {
    ...state,
    selectedSessionId: null,
    activeProjectId: null,
  };
}

export function openSettings(state: ShellNavState, section?: string): ShellNavState {
  return {
    ...state,
    settings: true,
    settingsSection: section ?? state.settingsSection,
  };
}

export function closeSettings(state: ShellNavState): ShellNavState {
  return { ...state, settings: false };
}

export interface ShellNavToPathInput {
  settings: boolean;
  settingsSection: string;
  lens: ShellLens;
  selectedSessionId: string | null;
  activeProjectId: string | null;
  nodeInfoNodeId: string | null;
}

/**
 * Primary paths: / , /agents , /agents/:sessionId , /p/:projectId , /n/:nodeId
 */
export function shellNavToPath(n: ShellNavToPathInput): string {
  if (n.settings) return `/settings/${n.settingsSection || 'appearance'}`;
  if (n.nodeInfoNodeId) return `/n/${n.nodeInfoNodeId}`;
  if (n.selectedSessionId) return `/agents/${n.selectedSessionId}`;
  if (n.activeProjectId) return `/p/${n.activeProjectId}`;
  if (n.lens === 'agents') return '/agents';
  return '/';
}

export type ShellNavPathPatch = Partial<
  Pick<
    ShellNavState,
    | 'lens'
    | 'chrome'
    | 'selectedSessionId'
    | 'activeProjectId'
    | 'nodeInfoNodeId'
    | 'settings'
    | 'settingsSection'
  >
>;

const SETTINGS_SECTIONS = new Set(['appearance', 'notifications', 'nodes', 'account', 'about']);

/**
 * URL → nav patch.
 * Defaults chrome to stage (D5); does not force tools open.
 */
export function pathToShellNav(pathname: string): ShellNavPathPatch {
  const seg = pathname.split('/').filter(Boolean);

  if (seg[0] === 'settings') {
    const section = seg[1];
    if (section && SETTINGS_SECTIONS.has(section)) {
      return { settings: true, settingsSection: section };
    }
    return { settings: true };
  }

  if (seg[0] === 'n' && seg[1]) {
    return {
      settings: false,
      nodeInfoNodeId: seg[1],
      lens: 'mission',
    };
  }

  if (seg[0] === 'agents') {
    if (seg[1]) {
      return {
        settings: false,
        lens: 'agents',
        chrome: 'stage',
        selectedSessionId: seg[1],
        activeProjectId: null,
        nodeInfoNodeId: null,
      };
    }
    return {
      settings: false,
      lens: 'agents',
      chrome: 'stage',
      selectedSessionId: null,
      activeProjectId: null,
      nodeInfoNodeId: null,
    };
  }

  if (seg[0] === 'p' && seg[1]) {
    return {
      settings: false,
      lens: 'agents',
      chrome: 'stage',
      activeProjectId: seg[1],
      selectedSessionId: null,
      nodeInfoNodeId: null,
    };
  }

  // / — Paddock (D1)
  return {
    settings: false,
    lens: 'mission',
    chrome: 'stage',
    selectedSessionId: null,
    activeProjectId: null,
    nodeInfoNodeId: null,
  };
}
