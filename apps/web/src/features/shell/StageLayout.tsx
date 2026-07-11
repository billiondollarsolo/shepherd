import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveStageProjectId,
  layoutArrangeMode,
  layoutSessionIds,
  type ArrangeMode,
  type ProjectLayoutV1,
  type ProjectPensV1,
} from '@flock/shared';
import { usePaddock, type PenAction, type PenSummary } from '../../store/paddock';
import { useSessions } from '../../data/queries';
import { TerminalArea } from '../terminal/TerminalArea';
import { ProjectLayoutView } from './ProjectLayoutView';
import { fetchProjectLayout } from './projectLayoutApi';
import { fetchProjectPens, putProjectPens } from './projectPensApi';
import {
  applySelectionZoom,
  rearrangeProjectLayout,
  reconcileProjectLayout,
} from './projectLayoutState';

const MAX_PEN_SIZE = 4;

function penId(index: number): string {
  return `pen-${index + 1}`;
}

function layoutFor(
  projectId: string,
  ids: readonly string[],
  mode: ArrangeMode = 'grid2x2',
  focus?: string | null,
): ProjectLayoutV1 {
  return rearrangeProjectLayout(projectId, ids, mode, focus) ??
    // Callers always provide at least one id.
    (() => {
      throw new Error('cannot build an empty Pen');
    })();
}

function migratePens(
  projectId: string,
  openIds: readonly string[],
  legacy: ProjectLayoutV1 | null,
): ProjectPensV1 {
  const legacyIds = legacy
    ? layoutSessionIds(legacy.root).filter((id) => openIds.includes(id)).slice(0, MAX_PEN_SIZE)
    : [];
  const assigned = new Set(legacyIds);
  const chunks: string[][] = [];
  if (legacyIds.length > 0) chunks.push(legacyIds);
  const remaining = openIds.filter((id) => !assigned.has(id));
  for (let index = 0; index < remaining.length; index += MAX_PEN_SIZE) {
    chunks.push(remaining.slice(index, index + MAX_PEN_SIZE));
  }
  if (chunks.length === 0 && openIds[0]) chunks.push([openIds[0]]);
  const pens = chunks.map((ids, index) => ({
    id: penId(index),
    name: `Pen ${index + 1}`,
    layout:
      index === 0 && legacy && legacyIds.length === layoutSessionIds(legacy.root).length
        ? { ...legacy, zoomedLeafId: null }
        : layoutFor(projectId, ids),
  }));
  return { version: 1, projectId, activePenId: pens[0]?.id ?? 'pen-1', pens };
}

function reconcilePens(
  document: ProjectPensV1,
  openIds: readonly string[],
): ProjectPensV1 {
  const open = new Set(openIds);
  const pens = document.pens.flatMap((pen) => {
    const ids = layoutSessionIds(pen.layout.root).filter((id) => open.has(id)).slice(0, 4);
    if (ids.length === 0) return [];
    const layout = reconcileProjectLayout(document.projectId, ids, pen.layout, null, {
      direction: layoutArrangeMode(pen.layout.root),
    });
    return layout ? [{ ...pen, layout: { ...layout, zoomedLeafId: null } }] : [];
  });
  const activePenId = pens.some((pen) => pen.id === document.activePenId)
    ? document.activePenId
    : (pens[0]?.id ?? 'pen-1');
  return { ...document, pens, activePenId };
}

function summaries(document: ProjectPensV1 | null): PenSummary[] {
  return (
    document?.pens.map((pen) => ({
      id: pen.id,
      name: pen.name,
      sessionIds: layoutSessionIds(pen.layout.root),
      arrange: layoutArrangeMode(pen.layout.root),
    })) ?? []
  );
}

export function StageLayout(): JSX.Element {
  const selectedSessionId = usePaddock((state) => state.selectedSessionId);
  const selectedProjectId = usePaddock((state) => state.selectedProjectId);
  const selectProject = usePaddock((state) => state.selectProject);
  const setPenState = usePaddock((state) => state.setPenState);
  const setPenActionHandler = usePaddock((state) => state.setPenActionHandler);
  const { data: sessions = [] } = useSessions();
  const selected = selectedSessionId
    ? sessions.find((session) => session.id === selectedSessionId) ?? null
    : null;
  const projectId = effectiveStageProjectId({
    selectedSessionId,
    selectedProjectId,
    selectedSessionProjectId: selected?.projectId ?? null,
  });
  const openInProject = useMemo(
    () =>
      projectId
        ? sessions.filter((session) => session.closedAt === null && session.projectId === projectId)
        : [],
    [sessions, projectId],
  );
  const openIds = useMemo(() => openInProject.map((session) => session.id), [openInProject]);
  const openKey = openIds.join(',');
  const byId = useMemo(() => new Map(openInProject.map((session) => [session.id, session])), [openInProject]);
  const [document, setDocument] = useState<ProjectPensV1 | null>(null);
  const [ready, setReady] = useState(false);
  const lastPersisted = useRef('');

  useEffect(() => {
    if (!projectId || openIds.length === 0) {
      setDocument(null);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void Promise.all([fetchProjectPens(projectId), fetchProjectLayout(projectId)]).then(
      ([stored, legacy]) => {
        if (cancelled) return;
        const next = stored
          ? reconcilePens(stored, openIds)
          : migratePens(projectId, openIds, legacy);
        setDocument(next);
        setReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, openKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPenState(projectId, summaries(document), document?.activePenId ?? null);
  }, [document, projectId, setPenState]);

  useEffect(() => {
    if (!document || !ready) return;
    const key = JSON.stringify(document);
    if (key === lastPersisted.current) return;
    lastPersisted.current = key;
    void putProjectPens(document).then((saved) => {
      if (saved) lastPersisted.current = JSON.stringify(saved);
    });
  }, [document, ready]);

  const updatePenLayout = useCallback((penIdValue: string, layout: ProjectLayoutV1) => {
    setDocument((current) =>
      current
        ? {
            ...current,
            pens: current.pens.map((pen) =>
              pen.id === penIdValue ? { ...pen, layout: { ...layout, zoomedLeafId: null } } : pen,
            ),
          }
        : current,
    );
  }, []);

  const handleAction = useCallback(
    (action: PenAction) => {
      setDocument((current) => {
        if (!current) return current;
        if (action.type === 'select' && action.penId) {
          return current.pens.some((pen) => pen.id === action.penId)
            ? { ...current, activePenId: action.penId }
            : current;
        }
        if (action.type === 'create') {
          const id = crypto.randomUUID();
          const sessionId = action.sessionId;
          if (!sessionId || !byId.has(sessionId)) return current;
          const pens = current.pens.map((pen) => {
            const ids = layoutSessionIds(pen.layout.root).filter((value) => value !== sessionId);
            return ids.length === 0
              ? null
              : { ...pen, layout: layoutFor(projectId!, ids, layoutArrangeMode(pen.layout.root)) };
          }).filter((pen): pen is NonNullable<typeof pen> => pen !== null);
          pens.push({ id, name: `Pen ${pens.length + 1}`, layout: layoutFor(projectId!, [sessionId]) });
          return { ...current, pens, activePenId: id };
        }
        if (action.type === 'arrange' && action.penId && action.mode) {
          return {
            ...current,
            pens: current.pens.map((pen) =>
              pen.id === action.penId
                ? { ...pen, layout: layoutFor(projectId!, layoutSessionIds(pen.layout.root), action.mode) }
                : pen,
            ),
          };
        }
        if (!action.sessionId) return current;
        const source = current.pens.find((pen) => layoutSessionIds(pen.layout.root).includes(action.sessionId!));
        const target = action.penId ? current.pens.find((pen) => pen.id === action.penId) : undefined;
        if (action.type === 'move' && source && target && source.id === target.id && action.targetSessionId) {
          const ids = layoutSessionIds(source.layout.root);
          const from = ids.indexOf(action.sessionId);
          const to = ids.indexOf(action.targetSessionId);
          if (from < 0 || to < 0) return current;
          const ordered = [...ids];
          [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
          return { ...current, pens: current.pens.map((pen) => pen.id === source.id ? { ...pen, layout: layoutFor(projectId!, ordered, layoutArrangeMode(pen.layout.root)) } : pen) };
        }
        const without = current.pens.flatMap((pen) => {
          const ids = layoutSessionIds(pen.layout.root).filter((id) => id !== action.sessionId);
          return ids.length === 0 ? [] : [{ ...pen, layout: layoutFor(projectId!, ids, layoutArrangeMode(pen.layout.root)) }];
        });
        if (action.type === 'remove') {
          const activePenId = without.some((pen) => pen.id === current.activePenId) ? current.activePenId : (without[0]?.id ?? current.activePenId);
          return { ...current, pens: without, activePenId };
        }
        if (!target) return current;
        const targetAfterRemoval = without.find((pen) => pen.id === target.id);
        if (!targetAfterRemoval) return current;
        let targetIds = layoutSessionIds(targetAfterRemoval.layout.root);
        if (targetIds.length >= MAX_PEN_SIZE) {
          if (!action.targetSessionId) return current;
          targetIds = targetIds.map((id) => id === action.targetSessionId ? action.sessionId! : id);
        } else {
          targetIds = [...targetIds, action.sessionId];
        }
        const pens = without.map((pen) => pen.id === target.id ? { ...pen, layout: layoutFor(projectId!, targetIds, layoutArrangeMode(pen.layout.root), action.sessionId) } : pen);
        return { ...current, pens, activePenId: target.id };
      });
      if (projectId) selectProject(projectId);
    },
    [byId, projectId, selectProject],
  );

  useEffect(() => {
    setPenActionHandler(handleAction);
    return () => setPenActionHandler(null);
  }, [handleAction, setPenActionHandler]);

  if (!projectId || openIds.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">No agents in this project.</div>;
  }
  if (!ready || !document) {
    return <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">Preparing project Pens…</div>;
  }
  const activePen = document.pens.find((pen) => pen.id === document.activePenId) ?? document.pens[0];
  if (!activePen) {
    return <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">Drag an agent into a new Pen from the sidebar.</div>;
  }
  const activeIds = layoutSessionIds(activePen.layout.root);
  const selectedOutside = selected && selected.projectId === projectId && !activeIds.includes(selected.id);
  if (selectedOutside) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3 py-1.5 text-2xs text-flock-ink-muted">
          <span className="flex-1">Agent focused — Pen membership is unchanged.</span>
          <button className="rounded px-2 py-1 hover:bg-flock-surface-2" onClick={() => selectProject(projectId)}>Back to {activePen.name}</button>
        </div>
        <div className="min-h-0 flex-1"><TerminalArea session={selected} register /></div>
      </div>
    );
  }
  const displayLayout = applySelectionZoom(activePen.layout, selectedSessionId);
  return (
    <ProjectLayoutView
      layout={displayLayout}
      showToolbar={false}
      onLayoutChange={(layout) => updatePenLayout(activePen.id, layout)}
      renderLeaf={(leafId, sessionId, kind) => {
        const session = sessionId ? byId.get(sessionId) : null;
        if (kind !== 'session' || !session) return <div className="flex h-full items-center justify-center text-xs text-flock-ink-muted">Unavailable</div>;
        const focused = displayLayout.zoomedLeafId === leafId || displayLayout.focusedLeafId === leafId;
        return <TerminalArea session={session} register={focused} />;
      }}
    />
  );
}
