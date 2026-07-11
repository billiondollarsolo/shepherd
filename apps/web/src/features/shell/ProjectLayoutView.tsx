/**
 * Project split layout renderer (Phase 3).
 * Renders a ProjectLayoutV1 tree; leaves host keep-mounted terminals via children render prop.
 *
 * Multi-agent stage (not zoomed):
 *   - Tab / pane click → focus that agent *in the multi layout* (no zoom).
 *   - Double-click tab/pane or the maximize control → single-agent focus (zoom).
 *   - Arrange: side-by-side (row), stacked (col), or 2×2 grid.
 *   - Split gutters are drag-resizable.
 */
import {
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Columns2, GripVertical, LayoutGrid, Maximize2, Rows2 } from 'lucide-react';
import {
  collectLeaves,
  layoutArrangeMode,
  setFocusedLeaf,
  setSplitRatio,
  type ArrangeMode,
  type LayoutNode,
  type ProjectLayoutV1,
} from '@flock/shared';

export interface ProjectLayoutViewProps {
  layout: ProjectLayoutV1;
  onLayoutChange: (next: ProjectLayoutV1) => void;
  /**
   * Rebuild multi-agent panes for a preset (row / col / 2×2).
   * Only used when 2+ leaves and not zoomed.
   */
  onArrangeMode?: (mode: ArrangeMode) => void;
  /** Sidebar-owned Pens hide the redundant main-content tab/arrange bar. */
  showToolbar?: boolean;
  /** Render a leaf's content (terminal, shell, …). */
  renderLeaf: (
    leafId: string,
    sessionId: string | undefined,
    kind: 'session' | 'shell',
  ) => ReactNode;
}

/** Gutter thickness (px) — also the middle track in the CSS grid. */
const GUTTER_PX = 6;

/** Swap two leaf positions without changing the user's split geometry. */
export function swapLayoutLeaves(
  layout: ProjectLayoutV1,
  sourceLeafId: string,
  targetLeafId: string,
): ProjectLayoutV1 {
  if (sourceLeafId === targetLeafId) return layout;
  const leaves = collectLeaves(layout.root);
  const source = leaves.find((leaf) => leaf.id === sourceLeafId);
  const target = leaves.find((leaf) => leaf.id === targetLeafId);
  if (!source || !target) return layout;

  const swap = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.id === sourceLeafId) return target;
      if (node.id === targetLeafId) return source;
      return node;
    }
    return { ...node, a: swap(node.a), b: swap(node.b) };
  };
  return { ...layout, root: swap(layout.root) };
}

function SplitNode({
  node,
  focusedLeafId,
  zoomedLeafId,
  onFocus,
  onZoom,
  onResizeSplit,
  renderLeaf,
  isRoot = false,
}: {
  node: LayoutNode;
  focusedLeafId: string;
  zoomedLeafId: string | null | undefined;
  /** Select agent in multi-view (no zoom). */
  onFocus: (leafId: string) => void;
  /** Enter single-agent full-stage for this leaf. */
  onZoom: (leafId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
  renderLeaf: ProjectLayoutViewProps['renderLeaf'];
  /** Root split is the zoom positioning context; nested nodes flatten via contents. */
  isRoot?: boolean;
}): JSX.Element {
  const splitRef = useRef<HTMLDivElement | null>(null);

  if (node.type === 'leaf') {
    const isZoomTarget = !!zoomedLeafId && zoomedLeafId === node.id;
    const isZoomHidden = !!zoomedLeafId && zoomedLeafId !== node.id;
    const focused = focusedLeafId === node.id || isZoomTarget;

    // CRITICAL: never unmount terminals when zoom-hiding a sibling. Unmounting
    // tears down xterm + PTY WS; remount on "All agents" races fit/replay and
    // leaves blank panes until hard refresh. Keep-alive under display:none and
    // re-fit when shown (Terminal IntersectionObserver + force redraw).
    if (isZoomHidden) {
      return (
        <div className="hidden" data-leaf={node.id} data-keep-alive="1" aria-hidden>
          {renderLeaf(node.id, node.sessionId, node.kind)}
        </div>
      );
    }

    return (
      <div
        data-testid={`layout-leaf-${node.id}`}
        data-focused={focused ? '1' : '0'}
        data-zoomed={isZoomTarget ? '1' : '0'}
        className={
          isZoomTarget
            ? 'absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col overflow-hidden bg-flock-surface-0 ring-1 ring-flock-accent'
            : `flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${focused ? 'ring-1 ring-flock-accent' : ''}`
        }
        onMouseDown={() => onFocus(node.id)}
        onDoubleClick={() => onZoom(node.id)}
      >
        {renderLeaf(node.id, node.sessionId, node.kind)}
      </div>
    );
  }

  // CSS grid with fr tracks: horizontal (row) and vertical (col) resize both map
  // cleanly to ratio without flex-grow quirks that broke side-by-side dragging.
  // When zoomed: root is the positioning context; nested splits/panes use
  // `display: contents` so the zoomed leaf's absolute inset-0 fills the stage.
  const isRow = node.direction === 'row';
  const anyZoom = !!zoomedLeafId;
  const style: CSSProperties = anyZoom
    ? isRoot
      ? {
          display: 'block',
          position: 'relative',
          height: '100%',
          width: '100%',
          minHeight: 0,
          minWidth: 0,
        }
      : { display: 'contents' }
    : isRow
      ? {
          display: 'grid',
          gridTemplateColumns: `minmax(0, ${node.ratio}fr) ${GUTTER_PX}px minmax(0, ${1 - node.ratio}fr)`,
          gridTemplateRows: 'minmax(0, 1fr)',
          height: '100%',
          width: '100%',
          minHeight: 0,
          minWidth: 0,
        }
      : {
          display: 'grid',
          gridTemplateRows: `minmax(0, ${node.ratio}fr) ${GUTTER_PX}px minmax(0, ${1 - node.ratio}fr)`,
          gridTemplateColumns: 'minmax(0, 1fr)',
          height: '100%',
          width: '100%',
          minHeight: 0,
          minWidth: 0,
        };

  const paneStyle: CSSProperties = anyZoom
    ? { display: 'contents' }
    : {
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      };

  const onSeparatorDown = (e: ReactMouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const el = splitRef.current;
    if (!el) return;

    // Absolute pointer position → ratio (more stable than start+delta for nested
    // row splits where re-layout can shift the gutter mid-drag).
    const measure = (clientX: number, clientY: number): number => {
      const r = el.getBoundingClientRect();
      if (isRow) {
        // Horizontal: pointer X as fraction of split width.
        return (clientX - r.left) / (r.width || 1);
      }
      // Vertical: pointer Y as fraction of split height.
      return (clientY - r.top) / (r.height || 1);
    };

    const onMove = (ev: MouseEvent): void => {
      onResizeSplit(node.id, measure(ev.clientX, ev.clientY));
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = isRow ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    // Apply once so a click-without-move doesn't feel dead.
    onResizeSplit(node.id, measure(e.clientX, e.clientY));
  };

  return (
    <div
      ref={splitRef}
      style={style}
      data-testid={`layout-split-${node.id}`}
      data-direction={node.direction}
      data-ratio={String(node.ratio)}
    >
      <div style={paneStyle}>
        <SplitNode
          node={node.a}
          focusedLeafId={focusedLeafId}
          zoomedLeafId={zoomedLeafId}
          onFocus={onFocus}
          onZoom={onZoom}
          onResizeSplit={onResizeSplit}
          renderLeaf={renderLeaf}
        />
      </div>
      <div
        role="separator"
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(node.ratio * 100)}
        aria-valuemin={5}
        aria-valuemax={95}
        aria-label={isRow ? 'Resize panes horizontally' : 'Resize panes vertically'}
        data-testid={`layout-separator-${node.id}`}
        onMouseDown={anyZoom ? undefined : onSeparatorDown}
        className={
          anyZoom
            ? 'hidden'
            : isRow
              ? 'relative z-20 w-full cursor-col-resize bg-[var(--flock-border)] hover:bg-flock-accent/70 active:bg-flock-accent'
              : 'relative z-20 h-full cursor-row-resize bg-[var(--flock-border)] hover:bg-flock-accent/70 active:bg-flock-accent'
        }
      />
      <div style={paneStyle}>
        <SplitNode
          node={node.b}
          focusedLeafId={focusedLeafId}
          zoomedLeafId={zoomedLeafId}
          onFocus={onFocus}
          onZoom={onZoom}
          onResizeSplit={onResizeSplit}
          renderLeaf={renderLeaf}
        />
      </div>
    </div>
  );
}

export function ProjectLayoutView({
  layout,
  onLayoutChange,
  onArrangeMode,
  showToolbar = true,
  renderLeaf,
}: ProjectLayoutViewProps): JSX.Element {
  const leaves = collectLeaves(layout.root);
  const zoomedId = layout.zoomedLeafId ?? null;
  const zoomedLeaf = zoomedId ? leaves.find((l) => l.id === zoomedId) : undefined;
  const multi = leaves.length > 1 && !zoomedLeaf;
  const arrange = multi ? layoutArrangeMode(layout.root) : null;
  const applyArrange = onArrangeMode;
  // 2×2 is most useful at 3–4 agents; still offered at 2 (degrades to a row).
  const canGrid2x2 = leaves.length >= 2 && leaves.length <= 4;

  const onResizeSplit = useCallback(
    (splitId: string, ratio: number) => {
      const next = setSplitRatio(layout, splitId, ratio);
      if (next !== layout) onLayoutChange(next);
    },
    [layout, onLayoutChange],
  );

  /** Focus in multi-view only — keep all panes visible. */
  const focusLeaf = useCallback(
    (leafId: string) => {
      onLayoutChange({
        ...setFocusedLeaf(layout, leafId),
        zoomedLeafId: null,
      });
    },
    [layout, onLayoutChange],
  );

  /** Leave multi-view and full-stage this agent. */
  const zoomLeaf = useCallback(
    (leafId: string) => {
      onLayoutChange({
        ...setFocusedLeaf(layout, leafId),
        zoomedLeafId: leafId,
      });
    },
    [layout, onLayoutChange],
  );

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-testid="project-layout-view"
      data-arrange={arrange ?? undefined}
    >
      {/* Multi-agent chrome: agent tabs + arrange presets (row / col / 2×2). */}
      {multi && showToolbar ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--flock-border)] px-2 py-1">
          <span className="mr-1 hidden text-2xs text-flock-ink-muted xl:inline">
            Pen · drag tabs to rearrange panes
          </span>
          {leaves.map((l) => {
            const focused = layout.focusedLeafId === l.id;
            return (
              <div key={l.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  draggable
                  data-testid={`layout-tab-${l.id}`}
                  title="Drag to rearrange. Click to focus; double-click to maximize."
                  className={`inline-flex cursor-grab items-center rounded py-0.5 pl-1 pr-2 text-2xs active:cursor-grabbing ${
                    focused
                      ? 'bg-flock-accent/15 text-flock-accent'
                      : 'text-flock-ink-muted hover:bg-flock-surface-2'
                  }`}
                  onClick={() => focusLeaf(l.id)}
                  onDoubleClick={() => zoomLeaf(l.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/flock-layout-leaf', l.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = event.dataTransfer.getData('text/flock-layout-leaf');
                    if (sourceId) onLayoutChange(swapLayoutLeaves(layout, sourceId, l.id));
                  }}
                >
                  <GripVertical className="mr-0.5 size-3 text-flock-ink-muted" />
                  {l.kind === 'shell' ? 'shell' : (l.sessionId ?? l.id).slice(0, 8)}
                </button>
                {focused ? (
                  <button
                    type="button"
                    data-testid={`layout-zoom-${l.id}`}
                    aria-label="Maximize agent"
                    title="Maximize to single-agent focus"
                    className="rounded p-0.5 text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-accent"
                    onClick={() => zoomLeaf(l.id)}
                  >
                    <Maximize2 className="size-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
          {applyArrange ? (
            <div
              className="ml-auto flex items-center gap-0.5 rounded-md border border-[var(--flock-border)] p-0.5"
              role="group"
              aria-label="Arrange agents"
              data-testid="arrange-direction"
            >
              <button
                type="button"
                data-testid="arrange-row"
                aria-label="Arrange side by side"
                aria-pressed={arrange === 'row'}
                title="Side by side (columns) — drag vertical gutters to resize"
                onClick={() => applyArrange('row')}
                className={`rounded p-1 ${
                  arrange === 'row'
                    ? 'bg-flock-accent/15 text-flock-accent'
                    : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
                }`}
              >
                <Columns2 className="size-3.5" />
              </button>
              <button
                type="button"
                data-testid="arrange-col"
                aria-label="Arrange stacked"
                aria-pressed={arrange === 'col'}
                title="Stacked (rows) — drag horizontal gutters to resize"
                onClick={() => applyArrange('col')}
                className={`rounded p-1 ${
                  arrange === 'col'
                    ? 'bg-flock-accent/15 text-flock-accent'
                    : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary'
                }`}
              >
                <Rows2 className="size-3.5" />
              </button>
              <button
                type="button"
                data-testid="arrange-grid2x2"
                aria-label="Arrange 2 by 2"
                aria-pressed={arrange === 'grid2x2'}
                title={
                  canGrid2x2
                    ? '2×2 grid — top row then bottom (best for 3–4 agents)'
                    : '2×2 grid works best with 2–4 agents'
                }
                disabled={!canGrid2x2}
                onClick={() => applyArrange('grid2x2')}
                className={`rounded p-1 ${
                  arrange === 'grid2x2'
                    ? 'bg-flock-accent/15 text-flock-accent'
                    : 'text-flock-ink-muted hover:bg-flock-surface-2 hover:text-flock-ink-primary disabled:opacity-40 disabled:hover:bg-transparent'
                }`}
              >
                <LayoutGrid className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {/*
        Always render the full split tree so every Terminal stays mounted.
        Zoom is CSS (absolute fill + keep-alive hidden siblings) — never a
        single-leaf remount that blanks panes on "All agents".
      */}
      <div
        className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
        data-zoomed={zoomedLeaf ? '1' : '0'}
      >
        <SplitNode
          node={layout.root}
          focusedLeafId={layout.focusedLeafId}
          zoomedLeafId={zoomedId}
          onFocus={focusLeaf}
          onZoom={zoomLeaf}
          onResizeSplit={onResizeSplit}
          renderLeaf={renderLeaf}
          isRoot
        />
      </div>
    </div>
  );
}
