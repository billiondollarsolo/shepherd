/**
 * Launch presets client (Phase 2).
 */
import {
  LauncherPresetsPayloadSchema,
  BUILTIN_LAUNCHER_PRESETS,
  type LauncherPreset,
} from '@flock/shared';
import { apiRequest } from '../../lib/apiClient';

export async function fetchLauncherPresets(
  fetchImpl: typeof fetch = fetch,
): Promise<LauncherPreset[]> {
  try {
    const body = await apiRequest('/api/me/launcher-presets', {
      schema: LauncherPresetsPayloadSchema,
      fetchImpl,
      idempotent: true,
      retry: { attempts: 1 },
    });
    return body.presets;
  } catch {
    return [...BUILTIN_LAUNCHER_PRESETS];
  }
}
