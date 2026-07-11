/**
 * Stage helpers for the paddock shell.
 * Pure functions so unit tests prove the real shipped entry points.
 */

/**
 * Effective project for the stage when a session may be selected.
 *
 * When a session is selected, the session's project always wins over a stale
 * project scope (deep-link /agents/:id after /p/other must not stage the wrong space).
 * When no session is selected, use the explicit project scope.
 */
export function effectiveStageProjectId(opts: {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  /** projectId of the selected session when known; null if unknown/loading */
  selectedSessionProjectId: string | null | undefined;
}): string | null {
  if (opts.selectedSessionId) {
    // Prefer known session project; if still loading, do NOT fall back to stale
    // selectedProjectId (that was the cross-project leak).
    return opts.selectedSessionProjectId ?? null;
  }
  return opts.selectedProjectId;
}

/**
 * Whether the stage should mount a multi-terminal grid host while layout loads.
 * Always false — keep-mounted path must not use GridView as a loading fallback.
 */
export function shouldUseGridViewAsLayoutFallback(): boolean {
  return false;
}

/**
 * Branch for StageLayout render mode without mounting dual terminal trees.
 * - `empty`: no project / no sessions
 * - `loading`: project known, layout not yet reconciled (skeleton, no second host)
 * - `layout`: ProjectLayoutView host
 */
export type StageRenderMode = 'empty' | 'loading' | 'layout';

export function stageRenderMode(opts: {
  projectId: string | null;
  openSessionCount: number;
  layoutReady: boolean;
}): StageRenderMode {
  if (!opts.projectId || opts.openSessionCount === 0) return 'empty';
  if (!opts.layoutReady) return 'loading';
  return 'layout';
}
