import {
  GetUserPreferencesResponse,
  PutUserPreferencesResponse,
  UserPreferencesDocumentSchema,
  type UserPreferencesDocument,
  type UserPreferencesValueV1,
} from '@flock/shared';
import { ApiError, apiRequest } from '../lib/apiClient';

export async function fetchUserPreferences(signal?: AbortSignal): Promise<UserPreferencesDocument> {
  const { preferences } = await apiRequest('/api/me/preferences', {
    method: 'GET',
    schema: GetUserPreferencesResponse,
    signal,
    idempotent: true,
    retry: { attempts: 2 },
  });
  return preferences;
}

export async function putUserPreferences(
  baseRevision: number,
  preferences: UserPreferencesValueV1,
  signal?: AbortSignal,
): Promise<UserPreferencesDocument> {
  try {
    const response = await apiRequest('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ baseRevision, preferences }),
      schema: PutUserPreferencesResponse,
      signal,
      idempotent: true,
      retry: { attempts: 2, baseDelayMs: 200 },
    });
    return response.preferences;
  } catch (error) {
    // A PUT can commit and lose its response. Its retry then sees a revision
    // conflict; if the server holds the exact desired document, treat that as
    // acknowledged instead of showing a false failure.
    if (error instanceof ApiError && error.code === 'preferences_conflict') {
      const parsed = UserPreferencesDocumentSchema.safeParse(
        (error.details as { preferences?: unknown } | undefined)?.preferences,
      );
      if (parsed.success) {
        const { revision: _revision, updatedAt: _updatedAt, ...currentValue } = parsed.data;
        if (JSON.stringify(currentValue) === JSON.stringify(preferences)) return parsed.data;
      }
    }
    throw error;
  }
}
