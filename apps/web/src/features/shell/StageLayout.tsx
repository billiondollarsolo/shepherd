import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveStageProjectId,
  layoutArrangeMode,
  layoutSessionIds,
  type ArrangeMode,
  type ProjectLayoutV1,
  type ProjectPensV1,
  ProjectPensResponseSchema,
} from '@flock/shared';
import { usePaddock, type PenAction, type PenSummary } from '../../store/paddock';
import { useSessions } from '../../data/queries';
import { TerminalArea } from '../terminal/TerminalArea';
import { ProjectLayoutView } from './ProjectLayoutView';
import { fetchProjectPens, putProjectPens } from './projectPensApi';
import { ApiError } from '../../lib/apiClient';
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
  return (
    rearrangeProjectLayout(projectId, ids, mode, focus) ??
    // Callers always provide at least one id.
    (() => {
      throw new Error('cannot build an empty Pen');
    })()
  );
}

function initialPens(projectId: string, openIds: readonly string[]): ProjectPensV1 {
  const chunks: string[][] = [];
  for (let index = 0; index < openIds.length; index += MAX_PEN_SIZE) {
    chunks.push(openIds.slice(index, index + MAX_PEN_SIZE));
  }
  if (chunks.length === 0 && openIds[0]) chunks.push([openIds[0]]);
  const pens = chunks.map((ids, index) => ({
    id: penId(index),
    name: `Pen ${index + 1}`,
    layout: layoutFor(projectId, ids),
  }));
  return { version: 1, projectId, activePenId: pens[0]?.id ?? 'pen-1', pens };
}

function reconcilePens(document: ProjectPensV1, openIds: readonly string[]): ProjectPensV1 {
  const open = new Set(openIds);
  const pens = document.pens.flatMap((pen) => {
    const ids = layoutSessionIds(pen.layout.root)
      .filter((id) => open.has(id))
      .slice(0, 4);
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
    ? (sessions.find((session) => session.id === selectedSessionId) ?? null)
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
  const byId = useMemo(
    () => new Map(openInProject.map((session) => [session.id, session])),
    [openInProject],
  );
  const [document, setDocument] = useState<ProjectPensV1 | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'retrying' | 'failed'>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNonce, setSaveNonce] = useState(0);
  const lastPersisted = useRef('');
  const saveSequence = useRef(0);
  const conflictRevision = useRef<number | null>(null);

  useEffect(() => {
    if (!projectId || openIds.length === 0) {
      setDocument(null);
      setLoadError(false);
      setRevision(0);
      setSaveState('saved');
      setReady(true);
      return;
    }
    let cancelled = false;
    setDocument(null);
    setReady(false);
    setLoadError(false);
    void fetchProjectPens(projectId)
      .then((stored) => {
        if (cancelled) return;
        const next = stored.pens
          ? reconcilePens(stored.pens, openIds)
          : initialPens(projectId, openIds);
        lastPersisted.current = stored.pens ? JSON.stringify(stored.pens) : '';
        setRevision(stored.revision);
        setDocument(next);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, openKey, loadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPenState(projectId, summaries(document), document?.activePenId ?? null);
  }, [document, projectId, setPenState]);

  useEffect(() => {
    if (!document || !ready) return;
    const key = JSON.stringify(document);
    if (key === lastPersisted.current) return;
    const sequence = ++saveSequence.current;
    const controller = new AbortController();
    setSaveState((state) => (state === 'failed' ? 'retrying' : 'saving'));
    setSaveError(null);
    void putProjectPens(document, revision, fetch, controller.signal)
      .then((saved) => {
        if (sequence !== saveSequence.current) return;
        lastPersisted.current = JSON.stringify(saved.pens);
        setRevision(saved.revision);
        setSaveState('saved');
      })
      .catch((error: unknown) => {
        if (sequence !== saveSequence.current) return;
        if (error instanceof ApiError && error.kind === 'aborted') return;
        if (error instanceof ApiError && error.code === 'pens_conflict') {
          const current = ProjectPensResponseSchema.safeParse(error.details);
          if (current.success) conflictRevision.current = current.data.revision;
        }
        setSaveState('failed');
        setSaveError(error instanceof Error ? error.message : 'Pens were not saved.');
      });
    return () => controller.abort();
  }, [document, ready, revision, saveNonce]);

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
        if (action.type === 'rename' && action.penId && action.name?.trim()) {
          return {
            ...current,
            pens: current.pens.map((pen) =>
              pen.id === action.penId ? { ...pen, name: action.name!.trim() } : pen,
            ),
          };
        }
        if (action.type === 'delete' && action.penId) {
          const pens = current.pens.filter((pen) => pen.id !== action.penId);
          return {
            ...current,
            pens,
            activePenId:
              current.activePenId === action.penId
                ? (pens[0]?.id ?? current.activePenId)
                : current.activePenId,
          };
        }
        if (action.type === 'create') {
          const id = crypto.randomUUID();
          const sessionId = action.sessionId;
          if (!sessionId || !byId.has(sessionId)) return current;
          const pens = current.pens
            .map((pen) => {
              const ids = layoutSessionIds(pen.layout.root).filter((value) => value !== sessionId);
              return ids.length === 0
                ? null
                : {
                    ...pen,
                    layout: layoutFor(projectId!, ids, layoutArrangeMode(pen.layout.root)),
                  };
            })
            .filter((pen): pen is NonNullable<typeof pen> => pen !== null);
          pens.push({
            id,
            name: `Pen ${pens.length + 1}`,
            layout: layoutFor(projectId!, [sessionId]),
          });
          return { ...current, pens, activePenId: id };
        }
        if (action.type === 'arrange' && action.penId && action.mode) {
          return {
            ...current,
            pens: current.pens.map((pen) =>
              pen.id === action.penId
                ? {
                    ...pen,
                    layout: layoutFor(projectId!, layoutSessionIds(pen.layout.root), action.mode),
                  }
                : pen,
            ),
          };
        }
        if (!action.sessionId) return current;
        const source = current.pens.find((pen) =>
          layoutSessionIds(pen.layout.root).includes(action.sessionId!),
        );
        const target = action.penId
          ? current.pens.find((pen) => pen.id === action.penId)
          : undefined;
        if (
          action.type === 'move' &&
          source &&
          target &&
          source.id === target.id &&
          action.targetSessionId
        ) {
          const ids = layoutSessionIds(source.layout.root);
          const from = ids.indexOf(action.sessionId);
          const to = ids.indexOf(action.targetSessionId);
          if (from < 0 || to < 0) return current;
          const ordered = [...ids];
          [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
          return {
            ...current,
            pens: current.pens.map((pen) =>
              pen.id === source.id
                ? {
                    ...pen,
                    layout: layoutFor(projectId!, ordered, layoutArrangeMode(pen.layout.root)),
                  }
                : pen,
            ),
          };
        }
        const without = current.pens.flatMap((pen) => {
          const ids = layoutSessionIds(pen.layout.root).filter((id) => id !== action.sessionId);
          return ids.length === 0
            ? []
            : [{ ...pen, layout: layoutFor(projectId!, ids, layoutArrangeMode(pen.layout.root)) }];
        });
        if (action.type === 'remove') {
          const activePenId = without.some((pen) => pen.id === current.activePenId)
            ? current.activePenId
            : (without[0]?.id ?? current.activePenId);
          return { ...current, pens: without, activePenId };
        }
        if (!target) return current;
        const targetAfterRemoval = without.find((pen) => pen.id === target.id);
        if (!targetAfterRemoval) return current;
        let targetIds = layoutSessionIds(targetAfterRemoval.layout.root);
        if (targetIds.length >= MAX_PEN_SIZE) {
          if (!action.targetSessionId) return current;
          targetIds = targetIds.map((id) =>
            id === action.targetSessionId ? action.sessionId! : id,
          );
        } else {
          targetIds = [...targetIds, action.sessionId];
        }
        const pens = without.map((pen) =>
          pen.id === target.id
            ? {
                ...pen,
                layout: layoutFor(
                  projectId!,
                  targetIds,
                  layoutArrangeMode(pen.layout.root),
                  action.sessionId,
                ),
              }
            : pen,
        );
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
    return (
      <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">
        No agents in this project.
      </div>
    );
  }
  if (!ready || !document) {
    if (loadError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-flock-ink-muted">
          <span>Could not load this project’s Pens.</span>
          <button
            type="button"
            className="rounded-md border border-[var(--flock-border)] px-3 py-1.5 text-flock-ink-primary hover:bg-flock-surface-2"
            onClick={() => setLoadNonce((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">
        Preparing project Pens…
      </div>
    );
  }
  const activePen =
    document.pens.find((pen) => pen.id === document.activePenId) ?? document.pens[0];
  const activeIds = activePen ? layoutSessionIds(activePen.layout.root) : [];
  const selectedOutside =
    selected &&
    selected.projectId === projectId &&
    (!activePen || !activeIds.includes(selected.id));
  if (selectedOutside) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3 py-1.5 text-2xs text-flock-ink-muted">
          <span className="flex-1">Agent focused — Pen membership is unchanged.</span>
          <button
            className="rounded px-2 py-1 hover:bg-flock-surface-2"
            onClick={() => selectProject(projectId)}
          >
            Back to {activePen?.name ?? 'project'}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TerminalArea session={selected} register />
        </div>
      </div>
    );
  }
  if (!activePen) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-flock-ink-muted">
        Drag an agent into a new Pen from the sidebar.
      </div>
    );
  }
  const displayLayout = applySelectionZoom(activePen.layout, selectedSessionId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {saveState !== 'saved' ? (
        <div
          className={`flex shrink-0 items-center gap-2 border-b border-[var(--flock-border)] px-3 py-1 text-2xs ${saveState === 'failed' ? 'text-status-error' : 'text-flock-ink-muted'}`}
          role={saveState === 'failed' ? 'alert' : 'status'}
          data-testid="pens-save-state"
        >
          <span className="flex-1">
            {saveState === 'failed'
              ? (saveError ?? 'Pens were not saved.')
              : saveState === 'retrying'
                ? 'Retrying Pen save…'
                : 'Saving Pens…'}
          </span>
          {saveState === 'failed' ? (
            <button
              type="button"
              className="rounded px-2 py-0.5 text-flock-ink-primary hover:bg-flock-surface-2"
              onClick={() => {
                if (conflictRevision.current !== null) {
                  const nextRevision = conflictRevision.current;
                  conflictRevision.current = null;
                  setRevision(nextRevision);
                } else {
                  setSaveNonce((value) => value + 1);
                }
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ProjectLayoutView
          layout={displayLayout}
          showToolbar={false}
          onLayoutChange={(layout) => updatePenLayout(activePen.id, layout)}
          renderLeaf={(leafId, sessionId, kind) => {
            const session = sessionId ? byId.get(sessionId) : null;
            if (kind !== 'session' || !session)
              return (
                <div className="flex h-full items-center justify-center text-xs text-flock-ink-muted">
                  Unavailable
                </div>
              );
            const focused =
              displayLayout.zoomedLeafId === leafId || displayLayout.focusedLeafId === leafId;
            return <TerminalArea session={session} register={focused} />;
          }}
        />
      </div>
    </div>
  );
}
