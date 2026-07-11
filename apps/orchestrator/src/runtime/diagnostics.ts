import { randomUUID } from 'node:crypto';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type DiagnosticValue = string | number | boolean | null;

export interface DiagnosticEvent {
  readonly id: string;
  readonly at: string;
  readonly category: string;
  readonly operation: string;
  readonly severity: DiagnosticSeverity;
  readonly correlationId?: string;
  readonly message: string;
  readonly context: Readonly<Record<string, DiagnosticValue>>;
}

export interface DiagnosticsSnapshot {
  readonly generatedAt: string;
  readonly counters: Readonly<Record<string, number>>;
  readonly events: readonly DiagnosticEvent[];
}

const SECRET_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)/i;
const SENSITIVE_VALUE =
  /(?:bearer\s+[a-z0-9._~+/=-]+|postgres(?:ql)?:\/\/[^\s@]+@|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;

export function redactDiagnosticValue(
  value: unknown,
  secretValues: readonly string[] = [],
): string {
  let result = value instanceof Error ? value.message : String(value);
  result = result.replace(SENSITIVE_VALUE, '[REDACTED]');
  for (const secret of secretValues) {
    if (secret.length >= 4) result = result.split(secret).join('[REDACTED]');
  }
  return result.slice(0, 500);
}

export class DiagnosticSink {
  private readonly events: DiagnosticEvent[] = [];
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly maxEvents = 200,
    private readonly now: () => Date = () => new Date(),
    private readonly secretValues: () => readonly string[] = () => [],
    private readonly maxCounters = 500,
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1)
      throw new Error('maxEvents must be positive');
    if (!Number.isInteger(maxCounters) || maxCounters < 1)
      throw new Error('maxCounters must be positive');
  }

  increment(name: string, amount = 1): void {
    const safe = name.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 100);
    this.counters.set(safe, (this.counters.get(safe) ?? 0) + amount);
    while (this.counters.size > this.maxCounters) {
      const oldest = this.counters.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.counters.delete(oldest);
    }
  }

  record(input: {
    category: string;
    operation: string;
    severity?: DiagnosticSeverity;
    correlationId?: string;
    message: unknown;
    context?: Readonly<Record<string, unknown>>;
  }): DiagnosticEvent {
    const secrets = this.secretValues();
    const context: Record<string, DiagnosticValue> = {};
    for (const [key, value] of Object.entries(input.context ?? {}).slice(0, 20)) {
      context[key.slice(0, 100)] = SECRET_KEY.test(key)
        ? '[REDACTED]'
        : typeof value === 'number' || typeof value === 'boolean' || value === null
          ? value
          : redactDiagnosticValue(value, secrets);
    }
    const event: DiagnosticEvent = {
      id: randomUUID(),
      at: this.now().toISOString(),
      category: input.category.slice(0, 100),
      operation: input.operation.slice(0, 100),
      severity: input.severity ?? 'error',
      correlationId: input.correlationId?.slice(0, 100),
      message: redactDiagnosticValue(input.message, secrets),
      context,
    };
    this.events.push(event);
    while (this.events.length > this.maxEvents) this.events.shift();
    this.increment(`${event.category}.${event.operation}.${event.severity}`);
    return event;
  }

  snapshot(): DiagnosticsSnapshot {
    return {
      generatedAt: this.now().toISOString(),
      counters: Object.fromEntries([...this.counters].sort(([a], [b]) => a.localeCompare(b))),
      events: this.events.map((event) => ({ ...event, context: { ...event.context } })),
    };
  }
}
