import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  UserPreferencesDocumentSchema,
  type UserPreferencesDocument,
  type UserPreferencesValueV1,
} from '@flock/shared';
import { fetchUserPreferences, putUserPreferences } from './preferencesApi';
import { ApiError } from '../lib/apiClient';
import { usePaddock } from '../store/paddock';

const preferencesKey = ['me', 'preferences'] as const;

function valueOf(document: UserPreferencesDocument): UserPreferencesValueV1 {
  const { revision: _revision, updatedAt: _updatedAt, ...value } = document;
  return value;
}

function serialized(value: UserPreferencesValueV1): string {
  return JSON.stringify(value);
}

function currentValue(): UserPreferencesValueV1 {
  const state = usePaddock.getState();
  return {
    version: 1,
    nodeOrder: state.nodeOrder,
    sessionOrder: state.sessionOrder,
    layoutPresets: state.layoutPresets,
  };
}

/** Three-way merge: remote wins untouched fields; local wins fields edited here. */
export function mergePreferences(
  base: UserPreferencesValueV1,
  local: UserPreferencesValueV1,
  remote: UserPreferencesValueV1,
): UserPreferencesValueV1 {
  const changed = <K extends keyof UserPreferencesValueV1>(key: K): boolean =>
    JSON.stringify(local[key]) !== JSON.stringify(base[key]);
  return {
    version: 1,
    nodeOrder: changed('nodeOrder') ? local.nodeOrder : remote.nodeOrder,
    sessionOrder: changed('sessionOrder') ? local.sessionOrder : remote.sessionOrder,
    layoutPresets: changed('layoutPresets') ? local.layoutPresets : remote.layoutPresets,
  };
}

/** Synchronizes cross-device preferences without putting network IO in the UI store. */
export function DurablePreferencesSync(): null {
  const hydrated = usePaddock((state) => state.preferencesHydrated);
  const revision = usePaddock((state) => state.preferencesRevision);
  const retryNonce = usePaddock((state) => state.preferencesRetryNonce);
  const nodeOrder = usePaddock((state) => state.nodeOrder);
  const sessionOrder = usePaddock((state) => state.sessionOrder);
  const layoutPresets = usePaddock((state) => state.layoutPresets);
  const local = useMemo<UserPreferencesValueV1>(
    () => ({ version: 1, nodeOrder, sessionOrder, layoutPresets }),
    [nodeOrder, sessionOrder, layoutPresets],
  );
  const baseline = useRef<UserPreferencesValueV1 | null>(null);
  const saving = useRef(false);

  const query = useQuery({
    queryKey: preferencesKey,
    queryFn: ({ signal }) => fetchUserPreferences(signal),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const refetch = query.refetch;

  useEffect(() => {
    const document = query.data;
    if (!document || saving.current) return;
    const clean = baseline.current === null || serialized(local) === serialized(baseline.current);
    if (!hydrated || clean) {
      baseline.current = valueOf(document);
      usePaddock.getState().hydrateDurablePreferences(document);
    }
  }, [query.data, hydrated, local]);

  useEffect(() => {
    if (query.isError && !hydrated) {
      const message =
        query.error instanceof Error ? query.error.message : 'Could not load preferences.';
      usePaddock.getState().setPreferencesSaveState('failed', message);
    }
  }, [query.isError, query.error, hydrated]);

  useEffect(() => {
    if (retryNonce > 0 && !hydrated) void refetch();
  }, [retryNonce, hydrated, refetch]);

  useEffect(() => {
    if (!hydrated || !baseline.current || serialized(local) === serialized(baseline.current))
      return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const desired = currentValue();
      const base = baseline.current!;
      const baseRevision = usePaddock.getState().preferencesRevision;
      saving.current = true;
      usePaddock.getState().setPreferencesSaveState('saving');
      void putUserPreferences(baseRevision, desired, controller.signal)
        .then((document) => {
          baseline.current = valueOf(document);
          usePaddock.getState().acknowledgeDurablePreferences(document.revision);
        })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.kind === 'aborted') return;
          if (error instanceof ApiError && error.code === 'preferences_conflict') {
            const parsed = UserPreferencesDocumentSchema.safeParse(
              (error.details as { preferences?: unknown } | undefined)?.preferences,
            );
            if (parsed.success) {
              const remote = valueOf(parsed.data);
              const merged = mergePreferences(base, desired, remote);
              baseline.current = remote;
              usePaddock.getState().hydrateDurablePreferences({
                ...merged,
                revision: parsed.data.revision,
                updatedAt: parsed.data.updatedAt,
              });
              usePaddock.getState().setPreferencesSaveState('retrying');
              return;
            }
          }
          usePaddock
            .getState()
            .setPreferencesSaveState(
              'failed',
              error instanceof Error ? error.message : 'Preferences were not saved.',
            );
        })
        .finally(() => {
          saving.current = false;
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hydrated, revision, retryNonce, local]);

  return null;
}
