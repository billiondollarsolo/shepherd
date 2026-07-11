/**
 * Activity feature (US-34, FR-UI5): the right activity sidebar — status timeline
 * (from events) + session metadata + note + the agent's live Plan. Public surface
 * for the paddock shell (US-30).
 */
export { ActivitySidebar } from './ActivitySidebar.js';
export type { ActivitySidebarProps } from './ActivitySidebar.js';

export {
  buildStatusTimeline,
  buildSessionMetadata,
  formatTimelineTimestamp,
  DEFAULT_TIMELINE_LIMIT,
} from './activityModel.js';
export type { StatusTimelineEntry, SessionMetadataRow } from './activityModel.js';
