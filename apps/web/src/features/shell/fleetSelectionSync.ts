/**
 * Production fleet-selection sync: GET first, PUT only on real local identity change.
 *
 * Cold start (lastSyncedKey=null) must never stamp updatedAt=now and PUT an empty
 * home selection over a sibling device's stored selection (LWW wipe).
 */
import type { FleetSelectionPayload, HostScope, ShellLens } from '@flock/shared';
import { mergeFleetSelectionLww } from '@flock/shared';
import {
  fetchFleetSelection,
  putFleetSelection,
  selectionFromStore,
} from './fleetSelectionClient';

export interface ShellSelectionSlice {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  hostScope: HostScope;
  lens: ShellLens;
  fleetSelectionFollow: boolean;
}

export interface ApplySelectionPatch {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  hostScope?: HostScope;
  lens?: ShellLens;
  view?: 'overview' | 'paddock';
}

/** Map remote payload into store fields (does not touch chrome/tools). */
export function remoteToStorePatch(remote: FleetSelectionPayload): ApplySelectionPatch {
  const patch: ApplySelectionPatch = {
    selectedSessionId: remote.selectedSessionId,
    selectedProjectId: remote.activeProjectId,
  };
  if (remote.hostScope !== undefined) patch.hostScope = remote.hostScope;
  if (remote.lens !== undefined) {
    patch.lens = remote.lens;
    patch.view = remote.lens === 'mission' && !remote.selectedSessionId ? 'overview' : 'paddock';
  }
  return patch;
}

export function localPayloadFromSlice(slice: ShellSelectionSlice): FleetSelectionPayload {
  return selectionFromStore({
    selectedSessionId: slice.selectedSessionId,
    selectedProjectId: slice.selectedProjectId,
    hostScope: slice.hostScope,
    lens: slice.lens,
  });
}

/** Identity of selection without timestamp — used to detect real local changes. */
export function selectionIdentity(p: {
  selectedSessionId: string | null;
  activeProjectId?: string | null;
  selectedProjectId?: string | null;
  hostScope?: HostScope | null;
  lens?: string | null;
}): string {
  const project = p.activeProjectId ?? p.selectedProjectId ?? '';
  return [
    p.selectedSessionId ?? '',
    project,
    JSON.stringify(p.hostScope ?? null),
    p.lens ?? '',
  ].join('|');
}

/** True when the user has more than the default empty-home selection. */
export function hasMeaningfulSelection(p: {
  selectedSessionId: string | null;
  activeProjectId?: string | null;
  selectedProjectId?: string | null;
}): boolean {
  return (
    p.selectedSessionId != null ||
    (p.activeProjectId != null && p.activeProjectId !== '') ||
    (p.selectedProjectId != null && p.selectedProjectId !== '')
  );
}

/**
 * One sync tick.
 *
 * Protocol:
 * 1. Always GET remote first.
 * 2. Cold start (`lastSyncedKey === null`): hydrate from remote when follow is on;
 *    never PUT a default empty home over an existing remote selection.
 * 3. Steady state: PUT only when local identity ≠ lastSyncedKey (user changed UI).
 * 4. Then, if follow is on and remote differs, apply remote (LWW if we also wrote).
 *
 * `writeKey` returned is the new lastSyncedKey for the caller to persist.
 */
export async function runFleetSelectionTick(opts: {
  slice: ShellSelectionSlice;
  /** Last local identity we intentionally synced (after apply or put). null = cold start. */
  lastSyncedKey: string | null;
  /** @deprecated alias for lastSyncedKey */
  lastWrittenKey?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  wrote: boolean;
  /** Persist as lastSyncedKey for the next tick. */
  writeKey: string | null;
  apply: ApplySelectionPatch | null;
  local: FleetSelectionPayload;
  puts: FleetSelectionPayload[];
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lastSyncedKey = opts.lastSyncedKey ?? opts.lastWrittenKey ?? null;
  const local = localPayloadFromSlice(opts.slice);
  const localId = selectionIdentity({
    selectedSessionId: local.selectedSessionId,
    activeProjectId: local.activeProjectId,
    hostScope: local.hostScope ?? null,
    lens: local.lens,
  });

  // 1. GET first — always
  const remote = await fetchFleetSelection(fetchImpl);
  const remoteId = remote
    ? selectionIdentity({
        selectedSessionId: remote.selectedSessionId,
        activeProjectId: remote.activeProjectId,
        hostScope: remote.hostScope ?? null,
        lens: remote.lens,
      })
    : null;

  let wrote = false;
  let apply: ApplySelectionPatch | null = null;
  let nextKey = lastSyncedKey;
  const puts: FleetSelectionPayload[] = [];

  // 2. Cold start
  if (lastSyncedKey === null) {
    if (remote && opts.slice.fleetSelectionFollow) {
      // Hydrate from server; do not PUT empty home over it
      if (remoteId !== localId) {
        apply = remoteToStorePatch(remote);
      }
      nextKey = remoteId;
      return { wrote: false, writeKey: nextKey, apply, local, puts };
    }

    if (remote && !opts.slice.fleetSelectionFollow) {
      // Know server state exists; do not wipe it with default empty
      if (hasMeaningfulSelection(local) && localId !== remoteId) {
        // URL/deep-link restored a real selection while follow is off → push
        const saved = await putFleetSelection(local, fetchImpl);
        if (saved) {
          wrote = true;
          puts.push(local);
          nextKey = localId;
        } else {
          nextKey = localId;
        }
      } else {
        // Stay on empty/default home without clobbering server
        nextKey = localId;
      }
      return { wrote, writeKey: nextKey, apply: null, local, puts };
    }

    // No remote
    if (hasMeaningfulSelection(local)) {
      const saved = await putFleetSelection(local, fetchImpl);
      if (saved) {
        wrote = true;
        puts.push(local);
      }
      nextKey = localId;
    } else {
      nextKey = localId; // empty identity baseline
    }
    return { wrote, writeKey: nextKey, apply: null, local, puts };
  }

  // 3. Steady state — PUT only when user changed local identity
  if (localId !== lastSyncedKey) {
    const saved = await putFleetSelection(local, fetchImpl);
    if (saved) {
      wrote = true;
      puts.push(local);
      nextKey = localId;
    }
  }

  // 4. Pull remote changes (follow)
  if (remote && opts.slice.fleetSelectionFollow && remoteId !== nextKey) {
    if (wrote) {
      // Concurrent write this tick: LWW on timestamps
      const merged = mergeFleetSelectionLww(local, remote);
      const mergedId = selectionIdentity({
        selectedSessionId: merged.selectedSessionId,
        activeProjectId: merged.activeProjectId,
        hostScope: merged.hostScope ?? null,
        lens: merged.lens,
      });
      if (mergedId === remoteId && remoteId !== localId) {
        apply = remoteToStorePatch(remote);
        nextKey = remoteId;
      }
    } else {
      apply = remoteToStorePatch(remote);
      nextKey = remoteId;
    }
  }

  return { wrote, writeKey: nextKey, apply, local, puts };
}

/** @deprecated use selectionIdentity */
export function selectionFingerprint(p: FleetSelectionPayload): string {
  return selectionIdentity(p) + '|' + p.updatedAt;
}
