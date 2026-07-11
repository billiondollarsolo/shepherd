/**
 * Launch presets client (Phase 2).
 */
import {
  LauncherPresetsPayloadSchema,
  BUILTIN_LAUNCHER_PRESETS,
  type LauncherPreset,
} from '@flock/shared';

export async function fetchLauncherPresets(
  fetchImpl: typeof fetch = fetch,
): Promise<LauncherPreset[]> {
  const res = await fetchImpl('/api/me/launcher-presets', { credentials: 'include' });
  if (!res.ok) return [...BUILTIN_LAUNCHER_PRESETS];
  const body = (await res.json()) as { presets: unknown };
  const parsed = LauncherPresetsPayloadSchema.safeParse({ presets: body.presets });
  if (!parsed.success) return [...BUILTIN_LAUNCHER_PRESETS];
  return parsed.data.presets;
}
