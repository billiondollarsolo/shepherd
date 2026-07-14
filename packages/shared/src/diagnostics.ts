import { z } from 'zod';
import { DeploymentModeSchema } from './contracts/auth.js';

const Availability = z.enum(['ready', 'available', 'unavailable', 'configured', 'not_configured']);
const ToolVersion = z.object({
  status: z.enum(['available', 'missing']),
  version: z.string().optional(),
});
const DiagnosticEvent = z.object({
  id: z.string().uuid(),
  at: z.string().datetime(),
  category: z.string(),
  operation: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  correlationId: z.string().optional(),
  message: z.string(),
  context: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const FlockDiagnosticsSchema = z
  .object({
    bundleVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    versions: z.object({
      flock: z.string(),
      agentdExpected: z.string(),
      agents: z.object({ codex: ToolVersion, claude: ToolVersion, opencode: ToolVersion }),
    }),
    deployment: z.object({
      mode: DeploymentModeSchema,
      transport: z.enum(['https', 'http']),
      publicBaseUrl: z.string().url().nullable(),
      trustedProxy: z.boolean(),
    }),
    health: z.object({
      process: z.object({ status: Availability, uptimeSeconds: z.number().nonnegative() }),
      database: z.object({ status: Availability }),
      migrations: z.object({ status: Availability, count: z.number().nonnegative().optional() }),
      agentd: z.unknown(),
      nodes: z.object({ status: Availability, count: z.number().nonnegative() }),
      disk: z.object({
        status: Availability,
        freeBytes: z.number().nonnegative().optional(),
        totalBytes: z.number().nonnegative().optional(),
      }),
      preview: z.object({
        status: Availability,
        active: z.number().int().nonnegative(),
        reason: z.string().nullable(),
      }),
      push: z.object({ status: Availability }),
    }),
    warnings: z.array(z.string()),
    collections: z.record(z.number().int().nonnegative()),
    diagnostics: z.object({
      generatedAt: z.string().datetime(),
      counters: z.record(z.number()),
      events: z.array(DiagnosticEvent),
    }),
    privacy: z.object({ included: z.string(), excluded: z.string() }),
  })
  .strict();

export type FlockDiagnostics = z.infer<typeof FlockDiagnosticsSchema>;
