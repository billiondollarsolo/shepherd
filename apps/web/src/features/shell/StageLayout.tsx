import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveStageProjectId,
  layoutArrangeMode,
  layoutSessionIds,
  type ProjectLayoutV1,
  type ProjectPensV1,
  ProjectPensResponseSchema,
} from '@flock/shared';
import type { Session } from '@flock/shared';
import { usePaddock, type PenAction, type PenSummary } from '../../store/paddock';
import { useSessions } from '../../data/queries';
import { TerminalArea } from '../terminal/TerminalArea';
import { isChatCapable } from '../chat/chatCapable';

// Lazy: ChatPanel (+ its diff/highlight/markdown subtree) is on-demand — only for a
// chat-mode session — so it loads in its own chunk instead of the paddock bundle.
const ChatPanel = lazy(() => import('../chat/ChatPanel').then((m) => ({ default: m.ChatPanel })));

/**
 * One agent tile in the stage/pen grid. Honors the agent's remembered Terminal/Chat
 * view (persisted per session), so the choice made in single-agent view carries into
 * the all-agents grid — with a small in-tile toggle to flip it either place. The
 * terminal stays MOUNTED under the chat view (kept `invisible`) so its PTY + the
 * per-session input writer survive the toggle.
 */
function StageLeaf({ session, focused }: { session: Session; focused: boolean }): JSX.Element {
  // The transport is chosen at launch (Chat vs Terminal), so the view is fixed:
  // a structured (Chat-mode) session shows the chat; a PTY (Terminal-mode) session
  // shows the native TUI. No in-tile toggle — the mode can't change, so there's
  // nothing to switch between.
  const chatActive = isChatCapable(session.agentType) && session.structuredChat;
  return (
    <div className="relative h-full min-h-0">
      <div className={`absolute inset-0 ${chatActive ? 'invisible' : ''}`}>
        <TerminalArea session={session} register={focused} />
      </div>
      {chatActive ? (
        <div className="absolute inset-0" data-testid={`stage-chat-${session.id}`}>
          <Suspense fallback={null}>
            <ChatPanel session={session} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
import { ProjectLayoutView } from './ProjectLayoutView';
import { fetchProjectPens, putProjectPens } from './projectPensApi';
import { ApiError } from '../../lib/apiClient';
import { applySelectionZoom } from './projectLayoutState';
import { initialPens, layoutForSessions, MAX_PEN_SIZE, reconcilePens } from './penPlacement';

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
        ? sessions
            .filter((session) => session.closedAt === null && session.projectId === projectId)
            .sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            )
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
    // DEBOUNCE: coalesce rapid changes (a resize/drag fires many) into ONE save.
    // Firing per-change and aborting the in-flight PUT races the server — an aborted
    // request can still COMMIT and bump the revision, so the next save carries a stale
    // baseRevision and self-conflicts ("Pens changed on another client"). Waiting for
    // the drag to settle sidesteps that entirely; no per-change abort.
    const handle = window.setTimeout(() => {
      const sequence = ++saveSequence.current;
      setSaveState((state) => (state === 'failed' ? 'retrying' : 'saving'));
      setSaveError(null);
      void putProjectPens(document, revision, fetch)
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
            if (current.success) {
              // Almost always a SELF-conflict from this owner's own rapid saves.
              // Adopt the server's revision and let the effect re-run to re-apply our
              // layout on top (last-write-wins for one's own pen layout) — not a failure.
              conflictRevision.current = current.data.revision;
              setRevision(current.data.revision);
              return;
            }
          }
          setSaveState('failed');
          setSaveError(error instanceof Error ? error.message : 'Pens were not saved.');
        });
    }, 350);
    return () => window.clearTimeout(handle);
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
          const deleted = current.pens.find((pen) => pen.id === action.penId);
          const newlyIndependent = deleted ? layoutSessionIds(deleted.layout.root) : [];
          const pens = current.pens.filter((pen) => pen.id !== action.penId);
          return {
            ...current,
            pens,
            independentSessionIds: [
              ...new Set([...current.independentSessionIds, ...newlyIndependent]),
            ],
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
                    layout: layoutForSessions(projectId!, ids, layoutArrangeMode(pen.layout.root)),
                  };
            })
            .filter((pen): pen is NonNullable<typeof pen> => pen !== null);
          pens.push({
            id,
            name: `Pen ${pens.length + 1}`,
            layout: layoutForSessions(projectId!, [sessionId]),
          });
          return {
            ...current,
            pens,
            activePenId: id,
            independentSessionIds: current.independentSessionIds.filter(
              (value) => value !== sessionId,
            ),
          };
        }
        if (action.type === 'arrange' && action.penId && action.mode) {
          return {
            ...current,
            pens: current.pens.map((pen) =>
              pen.id === action.penId
                ? {
                    ...pen,
                    layout: layoutForSessions(
                      projectId!,
                      layoutSessionIds(pen.layout.root),
                      action.mode,
                    ),
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
                    layout: layoutForSessions(
                      projectId!,
                      ordered,
                      layoutArrangeMode(pen.layout.root),
                    ),
                  }
                : pen,
            ),
          };
        }
        const without = current.pens.flatMap((pen) => {
          const ids = layoutSessionIds(pen.layout.root).filter((id) => id !== action.sessionId);
          return ids.length === 0
            ? []
            : [
                {
                  ...pen,
                  layout: layoutForSessions(projectId!, ids, layoutArrangeMode(pen.layout.root)),
                },
              ];
        });
        if (action.type === 'remove') {
          const activePenId = without.some((pen) => pen.id === current.activePenId)
            ? current.activePenId
            : (without[0]?.id ?? current.activePenId);
          return {
            ...current,
            pens: without,
            activePenId,
            independentSessionIds: [
              ...new Set([...current.independentSessionIds, action.sessionId]),
            ],
          };
        }
        if (!target) return current;
        const targetAfterRemoval = without.find((pen) => pen.id === target.id);
        if (!targetAfterRemoval) return current;
        let targetIds = layoutSessionIds(targetAfterRemoval.layout.root);
        let displacedSessionId: string | null = null;
        if (targetIds.length >= MAX_PEN_SIZE) {
          if (!action.targetSessionId) return current;
          displacedSessionId = action.targetSessionId;
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
                layout: layoutForSessions(
                  projectId!,
                  targetIds,
                  layoutArrangeMode(pen.layout.root),
                  action.sessionId,
                ),
              }
            : pen,
        );
        return {
          ...current,
          pens,
          activePenId: target.id,
          independentSessionIds: [
            ...current.independentSessionIds.filter((value) => value !== action.sessionId),
            ...(displacedSessionId ? [displacedSessionId] : []),
          ],
        };
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
          <StageLeaf session={selected} focused />
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
            return <StageLeaf session={session} focused={focused} />;
          }}
        />
      </div>
    </div>
  );
}
