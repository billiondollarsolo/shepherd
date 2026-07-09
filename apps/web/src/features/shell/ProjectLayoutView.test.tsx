import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectLayoutView } from './ProjectLayoutView';
import { singleSessionLayout, splitLeaf, collectLeaves } from '@flock/shared';

describe('ProjectLayoutView', () => {
  it('renders a single leaf and focuses via click', () => {
    const layout = singleSessionLayout('p1', 's1');
    const onChange = vi.fn();
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={onChange}
        renderLeaf={(id) => <div data-testid={`content-${id}`}>term</div>}
      />,
    );
    const leafId = collectLeaves(layout.root)[0]!.id;
    expect(screen.getByTestId(`layout-leaf-${leafId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`content-${leafId}`)).toHaveTextContent('term');
  });

  it('renders split tree for two sessions', () => {
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf',
      id: 'leaf-b',
      kind: 'session',
      sessionId: 's2',
    });
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={() => {}}
        renderLeaf={(id, sessionId) => (
          <div data-testid={`content-${sessionId}`}>{id}</div>
        )}
      />,
    );
    expect(screen.getByTestId('content-s1')).toBeInTheDocument();
    expect(screen.getByTestId('content-s2')).toBeInTheDocument();
    expect(screen.getByTestId(`layout-split-split-${leafA.id}-leaf-b`)).toBeInTheDocument();
  });

  it('tab click focuses in multi-view without zooming', () => {
    // Tab strip only renders when 2+ leaves and not zoomed.
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf' as const,
      id: 'leaf-b',
      kind: 'session' as const,
      sessionId: 's2',
    });
    const onChange = vi.fn();
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={onChange}
        renderLeaf={() => null}
      />,
    );
    fireEvent.click(screen.getByTestId(`layout-tab-${leafA.id}`));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0]![0].focusedLeafId).toBe(leafA.id);
    expect(onChange.mock.calls[0]![0].zoomedLeafId).toBeNull();
  });

  it('zoomed leaf fills stage while siblings stay keep-alive mounted', () => {
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = {
      ...splitLeaf(base, leafA.id, 'row', {
        type: 'leaf' as const,
        id: 'leaf-b',
        kind: 'session' as const,
        sessionId: 's2',
      }),
      zoomedLeafId: leafA.id,
    };
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={() => {}}
        renderLeaf={(_id, sessionId) => <div data-testid={`content-${sessionId}`}>x</div>}
      />,
    );
    expect(screen.getByTestId('content-s1')).toBeInTheDocument();
    // Sibling MUST stay mounted (blank-pane fix) under keep-alive.
    expect(screen.getByTestId('content-s2')).toBeInTheDocument();
    expect(document.querySelector('[data-keep-alive="1"]')).toBeTruthy();
    // No multi-agent tab strip while zoomed (header owns All agents).
    expect(screen.queryByTestId(`layout-tab-${leafA.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('project-layout-view').querySelector('[data-zoomed="1"]')).toBeTruthy();
    expect(screen.getByTestId(`layout-leaf-${leafA.id}`)).toHaveAttribute('data-zoomed', '1');
  });

  it('multi-view double-click / maximize requests zoom of that leaf', () => {
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf' as const,
      id: 'leaf-b',
      kind: 'session' as const,
      sessionId: 's2',
    });
    // Focus leaf-b so maximize control is visible.
    const focused = { ...layout, focusedLeafId: 'leaf-b' };
    const onChange = vi.fn();
    render(
      <ProjectLayoutView
        layout={focused}
        onLayoutChange={onChange}
        renderLeaf={() => null}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId('layout-tab-leaf-b'));
    expect(onChange.mock.calls.at(-1)![0].zoomedLeafId).toBe('leaf-b');
    expect(onChange.mock.calls.at(-1)![0].focusedLeafId).toBe('leaf-b');

    onChange.mockClear();
    fireEvent.click(screen.getByTestId('layout-zoom-leaf-b'));
    expect(onChange.mock.calls[0]![0].zoomedLeafId).toBe('leaf-b');
  });

  it('shows arrange row/col/2x2 controls and calls onArrangeMode', () => {
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf' as const,
      id: 'leaf-b',
      kind: 'session' as const,
      sessionId: 's2',
    });
    const onArrange = vi.fn();
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={() => {}}
        onArrangeMode={onArrange}
        renderLeaf={() => null}
      />,
    );
    expect(screen.getByTestId('arrange-direction')).toBeInTheDocument();
    expect(screen.getByTestId('arrange-row')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('arrange-col'));
    expect(onArrange).toHaveBeenCalledWith('col');
    fireEvent.click(screen.getByTestId('arrange-grid2x2'));
    expect(onArrange).toHaveBeenCalledWith('grid2x2');
  });

  it('drag-resizes a row (horizontal) split via the separator without changing focus', () => {
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf' as const,
      id: 'leaf-b',
      kind: 'session' as const,
      sessionId: 's2',
    });
    const splitId = layout.root.type === 'split' ? layout.root.id : '';
    const onChange = vi.fn();
    // Give the split a measurable size so clientX → ratio is defined.
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return {
          width: 400,
          height: 200,
          top: 0,
          left: 0,
          right: 400,
          bottom: 200,
          x: 0,
          y: 0,
          toJSON() {
            return {};
          },
        };
      },
    });
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={onChange}
        renderLeaf={() => null}
      />,
    );
    const sep = screen.getByTestId(`layout-separator-${splitId}`);
    // Absolute mapping: clientX 100 / width 400 → ratio 0.25
    fireEvent.mouseDown(sep, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document);
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.focusedLeafId).toBe(layout.focusedLeafId);
    expect(next.zoomedLeafId ?? null).toBeNull();
    expect(next.root.type).toBe('split');
    if (next.root.type === 'split') {
      expect(next.root.direction).toBe('row');
      expect(next.root.ratio).toBeCloseTo(0.25, 2);
    }
  });

  it('drag-resizes a col (vertical) split via the separator', () => {
    const base = singleSessionLayout('p1', 's1');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'col', {
      type: 'leaf' as const,
      id: 'leaf-b',
      kind: 'session' as const,
      sessionId: 's2',
    });
    const splitId = layout.root.type === 'split' ? layout.root.id : '';
    const onChange = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return {
          width: 400,
          height: 200,
          top: 0,
          left: 0,
          right: 400,
          bottom: 200,
          x: 0,
          y: 0,
          toJSON() {
            return {};
          },
        };
      },
    });
    render(
      <ProjectLayoutView
        layout={layout}
        onLayoutChange={onChange}
        renderLeaf={() => null}
      />,
    );
    const sep = screen.getByTestId(`layout-separator-${splitId}`);
    // clientY 150 / height 200 → ratio 0.75
    fireEvent.mouseDown(sep, { clientX: 200, clientY: 150 });
    fireEvent.mouseUp(document);
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.root.type).toBe('split');
    if (next.root.type === 'split') {
      expect(next.root.direction).toBe('col');
      expect(next.root.ratio).toBeCloseTo(0.75, 2);
    }
  });
});
