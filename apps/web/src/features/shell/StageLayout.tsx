/**
 * Stage terminal surface for the paddock: project layout + keep-mounted terminals.
 *
 * Focus model (herdr-aligned):
 *   - Open / select an agent → that leaf is ZOOMED full-stage (only that terminal).
 *   - "All agents" → clear selection + unzoom → every open agent visible.
 *   - Multi-agent arrange: side-by-side (row), stacked (col), or 2×2 grid.
 *
 * Zoom is derived from selection at render time (not a fragile post-hoc effect),
 * so a deep-link to /agents/:id always full-stages that agent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collectLeaves,
  effectiveStageProjectId,
  layoutArrangeMode,
  layoutPrimaryDirection,
  stageRenderMode,
  type ArrangeMode,
  type ProjectLayoutV1,
  type Session,
} from '@flock/shared';
import { usePaddock } from '../../store/paddock';
import { useSessions } from '../../data/queries';
import { TerminalArea } from '../terminal/TerminalArea';
import { ProjectLayoutView } from './ProjectLayoutView';
import { fetchProjectLayout, putProjectLayout } from './projectLayoutApi';
import {
  afterTerminateLayout,
  applySelectionZoom,
  rearrangeProjectLayout,
  reconcileProjectLayout,
} from './projectLayoutState';

export function StageLayout(): JSX.Element {
  const selectedSessionId = usePaddock((s) => s.selectedSessionId);
  const selectedProjectId = usePaddock((s) => s.selectedProjectId);
  const openAgent = usePaddock((s) => s.openAgent);
  const selectProject = usePaddock((s) => s.selectProject);
  const { data: sessions = [] } = useSessions();

  const selected = selectedSessionId
    ? sessions.find((s) => s.id === selectedSessionId)
    : null;

  const projectId = effectiveStageProjectId({
    selectedSessionId,
    selectedProjectId,
    selectedSessionProjectId: selected?.projectId ?? null,
  });

  const openInProject = useMemo(() => {
    if (!projectId) return [] as Session[];
    return sessions.filter((s) => s.closedAt === null && s.projectId === projectId);
  }, [sessions, projectId]);

  const openIds = useMemo(() => openInProject.map((s) => s.id), [openInProject]);
  const openIdsKey = openIds.join(',');

  /** Base layout tree (splits); zoom is NOT stored here as source of truth. */
  const [layout, setLayout] = useState<ProjectLayoutV1 | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const [stageWidth, setStageWidth] = useState<number | null>(null);
  const lastPersisted = useRef<string>('');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const byId = useMemo(() => new Map(openInProject.map((s) => [s.id, s])), [openInProject]);
  const fetchGen = useRef(0);
  /** Once the user picks row/col/2×2, keep it until project change (don't auto-flip on resize). */
  const userArrangeDir = useRef<ArrangeMode | null>(null);

  // Measure stage width for narrow→stacked default.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null && w > 0) setStageWidth(w);
    });
    ro.observe(el);
    if (el.clientWidth > 0) setStageWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [layoutReady, projectId]);

  // Load + reconcile when project or open set changes.
  useEffect(() => {
    userArrangeDir.current = null;
    if (!projectId) {
      setLayout(null);
      setLayoutReady(false);
      return;
    }
    if (openIds.length === 0) {
      setLayout(null);
      setLayoutReady(true);
      return;
    }

    const gen = ++fetchGen.current;
    let cancelled = false;
    setLayoutReady(false);
    void (async () => {
      const stored = await fetchProjectLayout(projectId);
      if (cancelled || gen !== fetchGen.current) return;
      // Prefer stored arrange mode (incl. 2×2); otherwise width-based default.
      if (stored?.projectId === projectId) {
        userArrangeDir.current = layoutArrangeMode(stored.root);
      }
      const reconciled = reconcileProjectLayout(projectId, openIds, stored, selectedSessionId, {
        direction: userArrangeDir.current,
        stageWidthPx: stageWidth,
      });
      setLayout(reconciled ? { ...reconciled, zoomedLeafId: null } : null);
      setLayoutReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, openIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // If first multi-agent load happened before width was known, re-default once.
  useEffect(() => {
    if (!layout || !layoutReady || !projectId || openIds.length < 2) return;
    if (userArrangeDir.current != null) return;
    if (stageWidth == null || stageWidth <= 0) return;
    const next = reconcileProjectLayout(projectId, openIds, layout, selectedSessionId, {
      stageWidthPx: stageWidth,
    });
    if (!next) return;
    if (layoutPrimaryDirection(next.root) !== layoutPrimaryDirection(layout.root)) {
      setLayout({ ...next, zoomedLeafId: null });
    }
    userArrangeDir.current = layoutPrimaryDirection(next.root);
  }, [stageWidth, layoutReady, openIdsKey, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayLayout = useMemo(() => {
    if (!layout) return null;
    return applySelectionZoom(layout, selectedSessionId);
  }, [layout, selectedSessionId]);

  useEffect(() => {
    if (!displayLayout || !projectId) return;
    const key = JSON.stringify(displayLayout);
    if (key === lastPersisted.current) return;
    lastPersisted.current = key;
    void putProjectLayout(displayLayout).then((saved) => {
      if (saved) lastPersisted.current = JSON.stringify(saved);
    });
  }, [displayLayout, projectId]);

  useEffect(() => {
    if (!projectId || !layout) return;
    const live = new Set(openIds);
    if (openIds.length === 0) {
      setLayout(null);
      return;
    }
    const pruned = afterTerminateLayout(layout, live);
    if (!pruned) {
      setLayout(null);
      return;
    }
    const needsReconcile =
      JSON.stringify(pruned) !== JSON.stringify(layout) ||
      openIds.length > collectLeaves(layout.root).filter((l) => l.kind === 'session').length;
    if (needsReconcile) {
      const next = reconcileProjectLayout(projectId, openIds, pruned, selectedSessionId, {
        direction: userArrangeDir.current ?? layoutPrimaryDirection(pruned.root),
        stageWidthPx: stageWidth,
      });
      setLayout(next ? { ...next, zoomedLeafId: null } : null);
    }
  }, [openIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onLayoutChange = useCallback(
    (next: ProjectLayoutV1) => {
      const wasZoomed = displayLayout?.zoomedLeafId ?? null;
      const wantsZoom = next.zoomedLeafId != null;

      // Leaving single-agent zoom → multi-agent project stage ("All agents").
      if (wasZoomed && !wantsZoom && projectId) {
        setLayout({ ...next, zoomedLeafId: null });
        selectProject(projectId);
        return;
      }

      // Multi-view focus / resize only: update the tree, stay on all agents.
      // Do NOT openAgent — that would zoom via selectedSessionId.
      if (!wantsZoom) {
        setLayout({ ...next, zoomedLeafId: null });
        return;
      }

      // Explicit maximize / double-click → single-agent focus.
      setLayout({ ...next, zoomedLeafId: null });
      const zoomLeaf = collectLeaves(next.root).find((l) => l.id === next.zoomedLeafId);
      if (zoomLeaf?.sessionId && projectId && zoomLeaf.sessionId !== selectedSessionId) {
        openAgent(zoomLeaf.sessionId, projectId);
      }
    },
    [openAgent, selectProject, projectId, selectedSessionId, displayLayout?.zoomedLeafId],
  );

  const onArrangeMode = useCallback(
    (mode: ArrangeMode) => {
      if (!projectId || openIds.length === 0) return;
      userArrangeDir.current = mode;
      const next = rearrangeProjectLayout(projectId, openIds, mode, selectedSessionId);
      if (next) setLayout({ ...next, zoomedLeafId: null });
    },
    [projectId, openIds, selectedSessionId],
  );

  const mode = stageRenderMode({
    projectId,
    openSessionCount: openInProject.length,
    layoutReady: layoutReady && displayLayout != null,
  });

  return (
    <div ref={stageRef} className="flex h-full min-h-0 w-full flex-col" data-testid="stage-layout">
      {mode === 'empty' ? (
        <div
          className="flex h-full items-center justify-center text-sm text-flock-ink-muted"
          data-testid="stage-empty"
        >
          Pick an agent from the paddock list to open its stage.
        </div>
      ) : mode === 'loading' || !displayLayout ? (
        <div
          className="flex h-full flex-col items-center justify-center gap-2 text-sm text-flock-ink-muted"
          data-testid="stage-loading"
        >
          <div className="size-6 animate-pulse rounded-full bg-flock-surface-2" />
          Preparing paddock stage…
        </div>
      ) : (
        <ProjectLayoutView
          layout={displayLayout}
          onLayoutChange={onLayoutChange}
          onArrangeMode={onArrangeMode}
          renderLeaf={(leafId, sessionId, kind) => {
            if (kind === 'shell' || !sessionId) {
              return (
                <div className="flex h-full items-center justify-center text-2xs text-flock-ink-muted">
                  Shell leaf {leafId}
                </div>
              );
            }
            const session = byId.get(sessionId);
            if (!session) {
              return (
                <div className="flex h-full items-center justify-center text-2xs text-flock-ink-muted">
                  Session closed
                </div>
              );
            }
            const focused =
              displayLayout.zoomedLeafId === leafId || displayLayout.focusedLeafId === leafId;
            return <TerminalArea session={session} register={focused} />;
          }}
        />
      )}
    </div>
  );
}
