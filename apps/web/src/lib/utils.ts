import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and de-dupe conflicting Tailwind utilities.
 * The standard shadcn/ui helper — used by every `components/ui/*` primitive.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Compact token count for the paddock telemetry chips: `1.2M` / `12k` / `1.2k` / `999`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Estimated session cost: sub-cent shows 4 dp, else 2 dp; `$`-prefixed. */
export function formatCostUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

const BYTES_PER_GB = 1024 ** 3;

/** Bytes → GB; 10+ GB rounds to whole numbers. `withUnit` appends `" GB"`. */
export function formatGB(bytes: number, withUnit = false): string {
  const v = (bytes / BYTES_PER_GB).toFixed(bytes >= 10 * BYTES_PER_GB ? 0 : 1);
  return withUnit ? `${v} GB` : v;
}
