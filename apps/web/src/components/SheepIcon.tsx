/**
 * Sheep — the Flock brand glyph (mdi-sheep), as a lucide-compatible icon.
 *
 * lucide-react has no sheep, so we ship the Material Design Icons sheep path as a
 * filled glyph that honors `currentColor` and a `className` (e.g. `size-4`), so it
 * drops in anywhere a lucide icon was used. Mirrors the favicon (public/icons).
 *
 * {@link FlockMark} is the full BRAND MARK (rounded blue tile + white sheep with
 * cut-out eyes) used in the app chrome — kept pixel-identical to the favicon so the
 * tab icon and the in-app logo match.
 */
import type { SVGProps } from 'react';

/** The mdi-sheep outline path (24×24 grid). */
const SHEEP_PATH =
  'M20,8.5A2.5,2.5 0 0,1 17.5,11C16.42,11 15.5,10.31 15.16,9.36C14.72,9.75 14.14,10 13.5,10C12.94,10 12.42,9.81 12,9.5C11.58,9.81 11.07,10 10.5,10C9.86,10 9.28,9.75 8.84,9.36C8.5,10.31 7.58,11 6.5,11A2.5,2.5 0 0,1 4,8.5C4,7.26 4.91,6.23 6.1,6.04C6.04,5.87 6,5.69 6,5.5A1.5,1.5 0 0,1 7.5,4C7.7,4 7.89,4.04 8.06,4.11C8.23,3.47 8.81,3 9.5,3C9.75,3 10,3.07 10.18,3.17C10.5,2.5 11.19,2 12,2C12.81,2 13.5,2.5 13.82,3.17C14,3.07 14.25,3 14.5,3C15.19,3 15.77,3.47 15.94,4.11C16.11,4.04 16.3,4 16.5,4A1.5,1.5 0 0,1 18,5.5C18,5.69 17.96,5.87 17.9,6.04C19.09,6.23 20,7.26 20,8.5M10,12A1,1 0 0,0 9,13A1,1 0 0,0 10,14A1,1 0 0,0 11,13A1,1 0 0,0 10,12M14,12A1,1 0 0,0 13,13A1,1 0 0,0 14,14A1,1 0 0,0 15,13A1,1 0 0,0 14,12M20.23,10.66C19.59,11.47 18.61,12 17.5,12C17.05,12 16.62,11.9 16.21,11.73C16.2,14.28 15.83,17.36 14.45,18.95C13.93,19.54 13.3,19.86 12.5,19.96V18H11.5V19.96C10.7,19.86 10.07,19.55 9.55,18.95C8.16,17.35 7.79,14.29 7.78,11.74C7.38,11.9 6.95,12 6.5,12C5.39,12 4.41,11.47 3.77,10.66C2.88,11.55 2,12 2,12C2,12 3,14 5,14C5.36,14 5.64,13.96 5.88,13.91C6.22,17.73 7.58,22 12,22C16.42,22 17.78,17.73 18.12,13.91C18.36,13.96 18.64,14 19,14C21,14 22,12 22,12C22,12 21.12,11.55 20.23,10.66Z';

/** Flock brand blue — fixed (NOT theme-adaptive) so the mark matches the favicon. */
const FLOCK_BLUE = '#2563eb';

export function Sheep({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d={SHEEP_PATH} />
    </svg>
  );
}

/**
 * FlockMark — the full brand mark: a rounded blue tile with a SOLID white sheep
 * (eyes are white too — no cut-outs). The 24×24 sheep is inset by 2 units inside
 * the 28×28 tile (≈2px padding at size-7), the tight logo ratio. Matches the
 * favicon (/public/icons/icon.svg). Blue is FIXED (not theme-adaptive) so the
 * in-app logo and the browser tab icon are identical in light and dark themes.
 */
export function FlockMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 28 28"
      role="img"
      aria-label="Flock"
      className={className}
      {...props}
    >
      <rect width="28" height="28" rx="8" fill={FLOCK_BLUE} />
      <path transform="translate(2 2)" fill="#ffffff" d={SHEEP_PATH} />
    </svg>
  );
}
