/**
 * Center feature (US-33, FR-UI4): the center-pane tab group
 * Terminal | Browser | Diff, defaulting to Terminal, plus the read-only Diff
 * tab and its API/parse helpers. Public surface for the paddock shell.
 */
export { CenterTabs, default as CenterTabsDefault } from './CenterTabs.js';
export type { CenterTab, CenterTabsProps } from './CenterTabs.js';

export { default as DiffTab } from './DiffTab.js';
export type { DiffTabProps } from './DiffTab.js';

export { fetchSessionDiff, DiffApiError } from './diffApi.js';
export type { FetchLike, DiffResponse } from './diffApi.js';

export { parseDiff, isEmptyDiff } from './diffLines.js';
export type { DiffLine, DiffLineKind } from './diffLines.js';
