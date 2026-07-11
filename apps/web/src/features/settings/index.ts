/**
 * Settings feature barrel.
 *
 *  - SettingsPage: full-page settings surface with an inner sidebar.
 *  - ScreencastSettings (US-29): screencast bandwidth controls panel.
 *  - AuditLogView (US-40): admin-only audit log surface (FR-A3).
 */
export { SettingsPage, SETTINGS_SECTIONS } from './SettingsPage';
export { ScreencastSettings } from './ScreencastSettings';
export { useScreencastSettings } from './useScreencastSettings';
export { AuditLogView } from './AuditLogView';
export { useAuditLog } from './useAuditLog';
export { fetchAuditLog, AuditApiError, type FetchLike as AuditFetchLike } from './auditApi';
