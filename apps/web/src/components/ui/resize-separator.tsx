import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * ResizeSeparator — the standardized, accessible drag handle for resizable split
 * layouts and side panels (US-31 / Phase 2). Renders a ≥8px pointer & touch hit
 * target (`min-*-touch`-friendly) with a centered 1px rule (`bg-flock-border`,
 * accenting on hover/active/focus) so every gutter in the app reads identically.
 *
 * It owns the pointer-drag lifecycle — pointer capture, global move/up listeners,
 * the body `cursor`/`user-select` lock, and cleanup — and delegates the pointer →
 * value math to the caller via `onDrag`, so each call-site keeps its exact
 * geometry. On top of the mouse-only idioms it replaces, it adds:
 *   - pointer events (mouse + touch parity — WCAG 2.5.1),
 *   - keyboard arrow-stepping announced through `aria-valuenow` (WCAG 2.1.1),
 *   - double-click-to-reset.
 *
 * Mirrors the WAI-ARIA `separator` (window splitter) pattern. Motion is
 * transition-only, so the universal `prefers-reduced-motion` block in polish.css
 * collapses it to a still state for free.
 */
const resizeSeparatorVariants = cva(
  'group relative shrink-0 touch-none select-none bg-transparent transition-colors ' +
    'before:pointer-events-none before:absolute before:bg-flock-border before:transition-colors ' +
    'hover:before:bg-flock-accent/70 active:before:bg-flock-accent ' +
    'focus-visible:outline-none focus-visible:shadow-focus focus-visible:before:bg-flock-accent ' +
    'aria-disabled:pointer-events-none aria-disabled:cursor-default',
  {
    variants: {
      orientation: {
        // A "vertical" separator is a vertical rule dividing left/right regions —
        // dragged horizontally (col-resize).
        vertical:
          'h-full w-2 cursor-col-resize before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2',
        // A "horizontal" separator is a horizontal rule dividing top/bottom
        // regions — dragged vertically (row-resize).
        horizontal:
          'w-full h-2 cursor-row-resize before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2',
      },
    },
    defaultVariants: {
      orientation: 'vertical',
    },
  },
);

export interface ResizeSeparatorProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onDrag' | 'onReset'>,
    VariantProps<typeof resizeSeparatorVariants> {
  /** Current position, surfaced as `aria-valuenow` (any unit the caller chooses). */
  value?: number;
  /** `aria-valuemin` + keyboard-stepping floor. */
  min?: number;
  /** `aria-valuemax` + keyboard-stepping ceiling. */
  max?: number;
  /** Keyboard arrow / Home / End increment, in the same unit as `value`. */
  step?: number;
  /** Non-interactive (e.g. while a pane is zoomed). */
  disabled?: boolean;
  /** Accessible label for the handle. */
  label?: string;
  /**
   * Fires on pointer-down and on every pointer-move during a drag. Read
   * `clientX` / `clientY` off the event to compute the new geometry.
   */
  onDrag?: (event: PointerEvent) => void;
  /**
   * Fires when the keyboard steps the value (arrows / Home / End). Receives the
   * already-clamped next value so the caller just applies it.
   */
  onValueChange?: (next: number) => void;
  /** Fires on double-click and Enter — reset to the default position. */
  onReset?: () => void;
}

export const ResizeSeparator = React.forwardRef<HTMLDivElement, ResizeSeparatorProps>(
  (
    {
      className,
      orientation = 'vertical',
      value,
      min = 0,
      max = 100,
      step = 1,
      disabled = false,
      label,
      onDrag,
      onValueChange,
      onReset,
      ...props
    },
    ref,
  ) => {
    const isVertical = orientation === 'vertical';

    const handlePointerDown = React.useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        // Primary button only; ignore secondary/middle. (A null/undefined button —
        // e.g. a synthetic pointer event with no button data — is treated as primary.)
        if (typeof e.button === 'number' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Capture so a fast drag that outruns the 1px rule keeps tracking. Guard
        // it: capture can throw for an inactive pointer id (e.g. under jsdom).
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          // Non-fatal — global listeners below still track the drag.
        }

        const onMove = (ev: PointerEvent): void => onDrag?.(ev);
        const onUp = (): void => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        // Apply once on down so a click-without-move still lands (no dead click).
        onDrag?.(e.nativeEvent);
      },
      [disabled, isVertical, onDrag],
    );

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const decKey = isVertical ? 'ArrowLeft' : 'ArrowUp';
        const incKey = isVertical ? 'ArrowRight' : 'ArrowDown';
        const current = value ?? min;
        let next: number | null = null;
        if (e.key === decKey) next = current - step;
        else if (e.key === incKey) next = current + step;
        else if (e.key === 'Home') next = min;
        else if (e.key === 'End') next = max;
        else if (e.key === 'Enter') {
          if (onReset) {
            e.preventDefault();
            onReset();
          }
          return;
        }
        if (next === null) return;
        e.preventDefault();
        onValueChange?.(Math.min(max, Math.max(min, next)));
      },
      [disabled, isVertical, value, min, max, step, onValueChange, onReset],
    );

    const handleDoubleClick = React.useCallback(() => {
      if (!disabled) onReset?.();
    }, [disabled, onReset]);

    return (
      <div
        ref={ref}
        role="separator"
        tabIndex={disabled ? -1 : 0}
        aria-orientation={orientation ?? 'vertical'}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={value != null ? min : undefined}
        aria-valuemax={value != null ? max : undefined}
        aria-disabled={disabled || undefined}
        data-orientation={orientation}
        className={cn(resizeSeparatorVariants({ orientation }), className)}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        onDoubleClick={handleDoubleClick}
        {...props}
      />
    );
  },
);
ResizeSeparator.displayName = 'ResizeSeparator';
