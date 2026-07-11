import type { ReactNode } from 'react';
import { useVisualViewportWidth } from './useVisualViewport';

/** Shared visual-viewport boundary for every non-stage mobile page. */
export function MobileViewportFrame({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId: string;
}): JSX.Element {
  const viewportWidth = useVisualViewportWidth();
  return (
    <div
      className="h-[100dvh] min-w-0 overflow-hidden"
      data-mobile-viewport=""
      data-testid={testId}
      style={{ width: viewportWidth == null ? '100%' : `${viewportWidth}px` }}
    >
      {children}
    </div>
  );
}
