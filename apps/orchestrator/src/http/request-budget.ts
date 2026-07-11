import type { FastifyReply } from 'fastify';

import { errorEnvelope } from './reply.js';

export interface RequestBudgetOptions {
  maxRequests: number;
  windowMs: number;
  maxConcurrent: number;
  maxConcurrentPerKey: number;
  maxKeys?: number;
  idleTtlMs?: number;
  now?: () => number;
  onReject?: (reason: 'rate' | 'concurrency') => void;
}

/**
 * Aggregate rejection reporter. It logs only at powers of two (1, 2, 4, ...),
 * so sustained abuse is visible without a log-amplification vector. Caller keys
 * and credentials are intentionally not accepted by this interface.
 */
export function makeRejectionReporter(
  scope: string,
  log: (message: string) => void = (message) => console.warn(message),
): (reason: 'rate' | 'concurrency') => void {
  const counts = { rate: 0, concurrency: 0 };
  return (reason) => {
    counts[reason] += 1;
    const count = counts[reason];
    if ((count & (count - 1)) === 0) {
      log(`[abuse] scope=${scope} reason=${reason} rejected=${count}`);
    }
  };
}

interface RateEntry {
  timestamps: number[];
  lastSeenAt: number;
}

export type RequestBudgetDecision =
  | { allowed: true; release(): void }
  | { allowed: false; reason: 'rate' | 'concurrency'; retryAfterMs: number };

/**
 * Bounded in-memory rate + concurrency policy. It deliberately stores only an
 * opaque caller key, never credentials. Entries expire and the oldest inactive
 * key is evicted at capacity, preventing unique-key traffic from growing memory.
 */
export class RequestBudget {
  private readonly rates = new Map<string, RateEntry>();
  private readonly activeByKey = new Map<string, number>();
  private activeTotal = 0;
  private readonly maxKeys: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private nextPruneAt = 0;
  private readonly rejectionCounts = { rate: 0, concurrency: 0 };

  constructor(private readonly options: RequestBudgetOptions) {
    for (const [name, value] of Object.entries({
      maxRequests: options.maxRequests,
      windowMs: options.windowMs,
      maxConcurrent: options.maxConcurrent,
      maxConcurrentPerKey: options.maxConcurrentPerKey,
    })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
    this.maxKeys = options.maxKeys ?? 5_000;
    this.idleTtlMs = options.idleTtlMs ?? Math.max(options.windowMs * 2, 60_000);
    this.now = options.now ?? Date.now;
    if (this.maxKeys <= 0 || this.idleTtlMs <= 0) {
      throw new Error('maxKeys and idleTtlMs must be positive');
    }
  }

  private reject(reason: 'rate' | 'concurrency', retryAfterMs: number): RequestBudgetDecision {
    this.rejectionCounts[reason] += 1;
    this.options.onReject?.(reason);
    return { allowed: false, reason, retryAfterMs: Math.max(1, retryAfterMs) };
  }

  private prune(now: number, force = false): void {
    if (!force && now < this.nextPruneAt) return;
    this.nextPruneAt = now + Math.max(1_000, Math.min(this.options.windowMs, this.idleTtlMs) / 4);
    const cutoff = now - this.options.windowMs;
    for (const [key, entry] of this.rates) {
      entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
      if (
        entry.timestamps.length === 0 &&
        now - entry.lastSeenAt >= this.idleTtlMs &&
        !this.activeByKey.has(key)
      ) {
        this.rates.delete(key);
      }
    }
  }

  private makeRoom(): void {
    if (this.rates.size < this.maxKeys) return;
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.rates) {
      if (!this.activeByKey.has(key) && entry.lastSeenAt < oldestAt) {
        oldestKey = key;
        oldestAt = entry.lastSeenAt;
      }
    }
    // Active concurrency is tracked separately, so evicting only the rate
    // history of the oldest active key is a safe last resort for the hard map
    // bound. Default maxConcurrent is far below maxKeys, making this exceptional.
    if (oldestKey === undefined) {
      for (const [key, entry] of this.rates) {
        if (entry.lastSeenAt < oldestAt) {
          oldestKey = key;
          oldestAt = entry.lastSeenAt;
        }
      }
    }
    if (oldestKey !== undefined) this.rates.delete(oldestKey);
  }

  enter(key: string): RequestBudgetDecision {
    const now = this.now();
    this.prune(now);
    let entry = this.rates.get(key);
    if (!entry) {
      this.makeRoom();
      entry = { timestamps: [], lastSeenAt: now };
      this.rates.set(key, entry);
    }
    entry.lastSeenAt = now;
    const cutoff = now - this.options.windowMs;
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
    if (entry.timestamps.length >= this.options.maxRequests) {
      return this.reject('rate', entry.timestamps[0]! + this.options.windowMs - now);
    }

    const activeForKey = this.activeByKey.get(key) ?? 0;
    if (
      this.activeTotal >= this.options.maxConcurrent ||
      activeForKey >= this.options.maxConcurrentPerKey
    ) {
      return this.reject('concurrency', 1_000);
    }

    entry.timestamps.push(now);
    this.activeTotal += 1;
    this.activeByKey.set(key, activeForKey + 1);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.activeTotal = Math.max(0, this.activeTotal - 1);
        const remaining = (this.activeByKey.get(key) ?? 1) - 1;
        if (remaining <= 0) this.activeByKey.delete(key);
        else this.activeByKey.set(key, remaining);
      },
    };
  }

  snapshot(): {
    trackedKeys: number;
    active: number;
    rejectedRate: number;
    rejectedConcurrency: number;
  } {
    this.prune(this.now(), true);
    return {
      trackedKeys: this.rates.size,
      active: this.activeTotal,
      rejectedRate: this.rejectionCounts.rate,
      rejectedConcurrency: this.rejectionCounts.concurrency,
    };
  }
}

/** Send the shared rejection envelope for a denied budget decision. */
export function replyRequestBudgetRejected(
  reply: FastifyReply,
  decision: Extract<RequestBudgetDecision, { allowed: false }>,
): FastifyReply {
  void reply.header('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
  return reply
    .code(429)
    .send(
      errorEnvelope(
        'too_many_requests',
        decision.reason === 'concurrency'
          ? 'Too many concurrent requests. Try again shortly.'
          : 'Request rate limit exceeded. Try again later.',
      ),
    );
}

/** Apply a budget around one request and always release its concurrency permit. */
export async function withinRequestBudget<T>(
  reply: FastifyReply,
  budget: RequestBudget,
  key: string,
  operation: () => Promise<T>,
): Promise<T | FastifyReply> {
  const decision = budget.enter(key);
  if (!decision.allowed) {
    return replyRequestBudgetRejected(reply, decision);
  }
  try {
    return await operation();
  } finally {
    decision.release();
  }
}
