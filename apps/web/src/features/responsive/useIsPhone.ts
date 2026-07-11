/**
 * `useIsPhone` — true when the viewport is phone-sized (US-36, FR-UI6).
 *
 * Drives the responsive collapse: above the breakpoint we render the dense
 * three-region desktop paddock (US-30); at or below it we render the phone away
 * view ("which agent needs me + approve/deny"). Implemented with `matchMedia` so
 * it tracks live resizes/rotations and there is a single source of truth for the
 * breakpoint (mirrored by the CSS so layout and JS agree).
 *
 * SSR/no-`matchMedia` safe: defaults to `false` (desktop) when the API is
 * unavailable.
 */
import { useEffect, useState } from 'react';

/** The phone breakpoint. Tailwind's `md` is 768px, so "below tablet" = phone. */
export const PHONE_MEDIA_QUERY = '(max-width: 767px)';

function getMql(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(PHONE_MEDIA_QUERY);
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState<boolean>(() => getMql()?.matches ?? false);

  useEffect(() => {
    const mql = getMql();
    if (!mql) return;

    const onChange = (e: MediaQueryListEvent | { matches: boolean }): void => {
      setIsPhone(e.matches);
    };
    // Sync once in case the query changed between render and effect.
    setIsPhone(mql.matches);

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Legacy Safari fallback.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return isPhone;
}
