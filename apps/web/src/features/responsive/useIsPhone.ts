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

/**
 * The phone breakpoint. Two OR-ed clauses:
 *
 *  1. `(max-width: 767px)` — Tailwind's `md` is 768px, so "below tablet" = phone
 *     (portrait phones, narrow windows).
 *  2. `(pointer: coarse) and (max-height: 575px)` — a touch device that is short
 *     is a *landscape* phone: wide enough to pass clause 1 on width, but with no
 *     room for the dense desktop paddock. Gating on `pointer: coarse` keeps short
 *     desktop windows (fine pointer) on the desktop shell.
 *
 * SINGLE SOURCE OF TRUTH — mirror any change by hand in `styles/responsive.css`
 * (custom properties can't parameterize a `@media` query).
 */
export const PHONE_MEDIA_QUERY =
  '(max-width: 767px), (pointer: coarse) and (max-height: 575px)';

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
