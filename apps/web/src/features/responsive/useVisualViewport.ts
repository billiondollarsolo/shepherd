import { useEffect, useState } from 'react';

/**
 * Safari can retain a stale layout viewport after rotation, browser-chrome
 * changes, or zoom. This is the width the user can actually see.
 */
export function useVisualViewportWidth(): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const update = (): void => {
      const next = window.visualViewport?.width ?? window.innerWidth;
      setWidth(Number.isFinite(next) && next > 0 ? Math.floor(next) : null);
    };
    const viewport = window.visualViewport;
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);

  return width;
}
