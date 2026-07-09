/**
 * Launch presets client (Phase 2).
 */
import {
  LauncherPresetsPayloadSchema,
  type LauncherPreset,
  mergePresetsWithBuiltins,
} from '@flock/shared';

export async function fetchLauncherPresets(
  fetchImpl: typeof fetch = fetch,
): Promise<LauncherPreset[]> {
  const res = await fetchImpl('/api/me/launcher-presets', { credentials: 'include' });
  if (!res.ok) return mergePresetsWithBuiltins([]);
  const body = (await res.json()) as { presets: unknown };
  const parsed = LauncherPresetsPayloadSchema.safeParse({ presets: body.presets });
  if (!parsed.success) return mergePresetsWithBuiltins([]);
  return parsed.data.presets;
}

export async function putLauncherPresets(
  presets: LauncherPreset[],
  fetchImpl: typeof fetch = fetch,
): Promise<LauncherPreset[]> {
  const res = await fetchImpl('/api/me/launcher-presets', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presets }),
  });
  if (!res.ok) return mergePresetsWithBuiltins(presets);
  const body = (await res.json()) as { presets: unknown };
  const parsed = LauncherPresetsPayloadSchema.safeParse({ presets: body.presets });
  return parsed.success ? parsed.data.presets : mergePresetsWithBuiltins(presets);
}
