import { z } from 'zod';

export const GridLayoutSchema = z.enum(['columns', 'grid']);
export type GridLayout = z.infer<typeof GridLayoutSchema>;

export const SavedLayoutPresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  projectId: z.string().uuid(),
  gridLayout: GridLayoutSchema,
  order: z.array(z.string().uuid()).max(256),
});
export type SavedLayoutPreset = z.infer<typeof SavedLayoutPresetSchema>;

export const UserPreferencesValueV1Schema = z
  .object({
    version: z.literal(1),
    nodeOrder: z.array(z.string().uuid()).max(256),
    sessionOrder: z.record(z.string().uuid(), z.array(z.string().uuid()).max(256)),
    layoutPresets: z.array(SavedLayoutPresetSchema).max(100),
  })
  .strict();
export type UserPreferencesValueV1 = z.infer<typeof UserPreferencesValueV1Schema>;

export const DEFAULT_USER_PREFERENCES: UserPreferencesValueV1 = {
  version: 1,
  nodeOrder: [],
  sessionOrder: {},
  layoutPresets: [],
};

export const UserPreferencesDocumentSchema = UserPreferencesValueV1Schema.extend({
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(),
});
export type UserPreferencesDocument = z.infer<typeof UserPreferencesDocumentSchema>;

export const GetUserPreferencesResponse = z.object({ preferences: UserPreferencesDocumentSchema });
export type GetUserPreferencesResponse = z.infer<typeof GetUserPreferencesResponse>;

export const PutUserPreferencesRequest = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    preferences: UserPreferencesValueV1Schema,
  })
  .strict();
export type PutUserPreferencesRequest = z.infer<typeof PutUserPreferencesRequest>;

export const PutUserPreferencesResponse = z.object({ preferences: UserPreferencesDocumentSchema });
export type PutUserPreferencesResponse = z.infer<typeof PutUserPreferencesResponse>;
