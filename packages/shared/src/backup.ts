import { z } from 'zod';

export const FlockVaultManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    flockVersion: z.string().min(1).max(64),
    createdAt: z.string().datetime(),
    migrationCount: z.number().int().nonnegative(),
    database: z.object({
      format: z.literal('pg-custom'),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      recordCounts: z.record(z.string().regex(/^[a-z_]+$/), z.number().int().nonnegative()),
    }),
    masterKey: z.object({
      currentVersion: z.number().int().nonnegative(),
      fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/),
      requiredVersions: z.array(z.number().int().nonnegative()).max(64),
    }),
    included: z.array(z.string().min(1).max(200)).max(64),
    excluded: z.array(z.string().min(1).max(200)).max(64),
    liveSessionSemantics: z.literal('metadata-only-processes-reconciled'),
    deployment: z.object({
      mode: z.string().min(1).max(100),
      declaredDurableVolumes: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            disposition: z.enum(['captured', 'external-backup-required', 'reconciled']),
          }),
        )
        .max(32),
    }),
  })
  .strict();

export type FlockVaultManifest = z.infer<typeof FlockVaultManifestSchema>;
