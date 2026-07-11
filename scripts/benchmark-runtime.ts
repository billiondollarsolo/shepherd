import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { orderNodes } from '../apps/web/src/store/paddock.js';
import { orderSessions } from '../apps/web/src/features/paddock/sessionOrder.js';
import { buildFleetIndex } from '../apps/web/src/features/overview/fleetModel.js';
import {
  DEFAULT_RESUME_BUFFER_BYTES,
  ResumeRing,
} from '../apps/orchestrator/src/sessions/pty-ws/pty-session.js';

interface Measurement {
  readonly scenario: string;
  readonly scale: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly thresholdMs: number;
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
}

function measure(
  scenario: string,
  scale: number,
  iterations: number,
  thresholdMs: number,
  operation: () => void,
): Measurement {
  for (let warmup = 0; warmup < 5; warmup += 1) operation();
  const samples: number[] = [];
  for (let sample = 0; sample < 15; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) operation();
    samples.push((performance.now() - started) / iterations);
  }
  const result = {
    scenario,
    scale,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    thresholdMs,
  };
  if (result.p95Ms > thresholdMs) {
    throw new Error(
      `${scenario} (${scale}) p95 ${result.p95Ms.toFixed(3)} ms exceeds ${thresholdMs} ms`,
    );
  }
  return result;
}

const measurements: Measurement[] = [];
for (const scale of [1, 4, 12, 50, 200]) {
  const nodes = Array.from({ length: scale }, (_, index) => ({
    id: `node-${index}`,
    name: `Node ${String(scale - index).padStart(3, '0')}`,
  }));
  const projects = nodes.flatMap((node, index) =>
    Array.from({ length: 2 }, (_, projectIndex) => ({
      id: `project-${index}-${projectIndex}`,
      nodeId: node.id,
    })),
  ) as Parameters<typeof buildFleetIndex>[0];
  const sessions = nodes.flatMap((node, index) =>
    Array.from({ length: 4 }, (_, sessionIndex) => ({
      id: `session-${index}-${sessionIndex}`,
      nodeId: node.id,
      projectId: `project-${index}-${sessionIndex % 2}`,
      closedAt: sessionIndex === 3 ? '2026-01-01T00:00:00.000Z' : null,
      createdAt: `2026-01-01T00:00:${String(sessionIndex).padStart(2, '0')}.000Z`,
    })),
  ) as Parameters<typeof orderSessions>[0];
  const order = [...nodes].reverse().map(({ id }) => id);
  const sessionOrder = [...sessions].reverse().map(({ id }) => id);
  const iterations = Math.max(50, Math.ceil(10_000 / scale));

  measurements.push(
    measure('fleet-index-sort-and-session-order', scale, iterations, scale === 200 ? 5 : 2, () => {
      orderNodes(nodes, order);
      buildFleetIndex(projects, sessions);
      orderSessions(sessions, sessionOrder);
    }),
  );
}

const ring = new ResumeRing(DEFAULT_RESUME_BUFFER_BYTES);
const chunk = Buffer.alloc(4096, 0x61);
measurements.push(
  measure('terminal-resume-buffer-write', DEFAULT_RESUME_BUFFER_BYTES, 50, 8, () => {
    ring.clear();
    for (let index = 0; index < 1024; index += 1) ring.push(chunk);
  }),
);
measurements.push(
  measure('terminal-resume-buffer-replay', DEFAULT_RESUME_BUFFER_BYTES, 50, 8, () => {
    const replay = ring.snapshot();
    if (replay.length !== DEFAULT_RESUME_BUFFER_BYTES) {
      throw new Error(`resume buffer exceeded/undershot its cap: ${replay.length}`);
    }
  }),
);

const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  samplesPerScenario: 15,
  measurements,
  memoryCeilings: {
    orchestratorResumeBytesPerAttachedSession: DEFAULT_RESUME_BUFFER_BYTES,
    agentdScrollbackBytesPerSession: 2 * 1024 * 1024,
    browserTerminalScrollbackLines: 10_000,
  },
};

for (const item of measurements) {
  console.log(
    `${item.scenario.padEnd(38)} ${String(item.scale).padStart(7)}  median ${item.medianMs.toFixed(3).padStart(8)} ms  p95 ${item.p95Ms.toFixed(3).padStart(8)} ms  limit ${item.thresholdMs} ms`,
  );
}

const outputArg = process.argv.find((argument) => argument.startsWith('--output='));
if (outputArg) {
  const output = resolve(outputArg.slice('--output='.length));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${output}`);
}
