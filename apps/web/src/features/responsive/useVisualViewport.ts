import { useEffect, useState } from 'react';

/**
 * Track a `window.visualViewport` dimension (falling back to the layout viewport
 * on browsers without the API). Safari can retain a stale layout viewport after
 * rotation, browser-chrome changes, or zoom, and — crucially for the terminal
 * stage — the software keyboard shrinks the *visual* viewport but not the layout
 * one, so reading `dvh`/`innerHeight` leaves the key strip stranded behind the
 * keyboard. Reading the visual viewport is what keeps chrome above the keyboard.
 */
function useVisualViewport(axis: 'width' | 'height'): number | null {
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    const update = (): void => {
      const next =
        axis === 'width'
          ? (window.visualViewport?.width ?? window.innerWidth)
          : (window.visualViewport?.height ?? window.innerHeight);
      setValue(Number.isFinite(next) && next > 0 ? Math.floor(next) : null);
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
  }, [axis]);

  return value;
}

/** The width the user can actually see (see {@link useVisualViewport}). */
export function useVisualViewportWidth(): number | null {
  return useVisualViewport('width');
}

/**
 * The height the user can actually see. Shrinks when the software keyboard
 * opens, so the terminal key strip can ride above the keyboard instead of being
 * pushed off-screen.
 */
export function useVisualViewportHeight(): number | null {
  return useVisualViewport('height');
}
