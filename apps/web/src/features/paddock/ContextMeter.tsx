/**
 * ContextMeter — a compact, informational gauge of how full an agent's context
 * window is. On a flat-rate coding plan the dollar cost is noise; what's actually
 * useful for supervision is *context fullness* — the "running out of room /
 * compaction imminent" signal. Purely informative (no alerting): a thin bar that
 * shifts calm → amber → red as the window fills, with a tokens tooltip.
 *
 * Telemetry source: contextPct / contextTokens / contextLimit ride the status WS
 * (see liveData.applyTelemetry) into the agentd-health cache.
 */

/** Tone thresholds — calm under 70%, warming by 70%, near-full by 90%. Pure. */
export function contextTone(pct: number): 'calm' | 'warn' | 'full' {
  if (pct >= 90) return 'full';
  if (pct >= 70) return 'warn';
  return 'calm';
}

const TONE_COLOR: Record<ReturnType<typeof contextTone>, string> = {
  calm: 'var(--flock-accent)',
  warn: 'var(--flock-status-awaiting)',
  full: 'var(--flock-status-error)',
};

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

export function ContextMeter({
  pct,
  tokens,
  limit,
  className,
}: {
  pct: number;
  tokens?: number;
  limit?: number;
  className?: string;
}): JSX.Element {
  const tone = contextTone(pct);
  const color = TONE_COLOR[tone];
  const title =
    tokens != null && limit != null
      ? `${pct}% context — ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens`
      : `${pct}% of context window used`;
  return (
    <span
      className={`flex items-center gap-1.5 ${className ?? ''}`}
      title={title}
      data-testid="context-meter"
      data-context-tone={tone}
      role="progressbar"
      aria-label="context window used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamp(pct)}
    >
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-flock-surface-2">
        <span
          className="block h-full rounded-full transition-[width] duration-300"
          style={{ width: `${clamp(pct)}%`, background: color }}
        />
      </span>
      <span
        className="text-2xs tabular-nums text-flock-ink-muted"
        style={tone === 'calm' ? undefined : { color }}
      >
        {pct}%
      </span>
    </span>
  );
}
