import { z } from 'zod';

const StrictSemver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'must be a complete semantic version',
  );

/** Release-owned contract describing which remote daemons this Shepherd accepts. */
export const AgentdCompatibilityPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    minimumDaemonVersion: StrictSemver,
    preferredProtocolVersion: z.number().int().positive(),
    supportedProtocolVersions: z.array(z.number().int().positive()).min(1),
    requiredCapabilities: z.array(z.string().min(1)).min(1),
    supportWindow: z
      .object({
        minorReleases: z.number().int().positive(),
        minimumDays: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (!policy.supportedProtocolVersions.includes(policy.preferredProtocolVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preferredProtocolVersion'],
        message: 'must be included in supportedProtocolVersions',
      });
    }
    if (
      new Set(policy.supportedProtocolVersions).size !== policy.supportedProtocolVersions.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportedProtocolVersions'],
        message: 'must contain unique versions',
      });
    }
    if (new Set(policy.requiredCapabilities).size !== policy.requiredCapabilities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredCapabilities'],
        message: 'must contain unique capabilities',
      });
    }
  });
export type AgentdCompatibilityPolicy = z.infer<typeof AgentdCompatibilityPolicySchema>;

export const AgentdCompatibilityStateSchema = z.enum(['compatible', 'recommended', 'required']);
export type AgentdCompatibilityState = z.infer<typeof AgentdCompatibilityStateSchema>;

export const AgentdCompatibilityReasonSchema = z.enum([
  'current',
  'newer-compatible',
  'older-supported',
  'service-migration',
  'not-installed',
  'invalid-version',
  'below-minimum',
  'unsupported-protocol',
  'missing-capabilities',
  'unverified-runtime',
]);
export type AgentdCompatibilityReason = z.infer<typeof AgentdCompatibilityReasonSchema>;

/** Stable API/UI result derived from release policy and authenticated daemon facts. */
export const AgentdCompatibilitySchema = z.object({
  state: AgentdCompatibilityStateSchema,
  reason: AgentdCompatibilityReasonSchema,
  installedVersion: z.string(),
  preferredVersion: StrictSemver,
  minimumVersion: StrictSemver,
  protocolVersion: z.number().int().positive().nullable(),
  supportedProtocolVersions: z.array(z.number().int().positive()).min(1),
  missingCapabilities: z.array(z.string()),
  servicePrepared: z.boolean(),
  binaryReplacement: z.boolean(),
  detail: z.string().min(1),
});
export type AgentdCompatibility = z.infer<typeof AgentdCompatibilitySchema>;
