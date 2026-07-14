import { z } from 'zod';
import { UserSchema } from '../domain.js';

// --- auth ------------------------------------------------------------------

/** POST /api/auth/setup — first-run owner creation (409 once an owner exists). */
export const SetupRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(12),
  /** Out-of-band fresh-install capability; required when production config says so. */
  setupToken: z.string().min(1).optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;
export const SetupResponse = z.object({ user: UserSchema });
export type SetupResponse = z.infer<typeof SetupResponse>;

/** POST /api/auth/login — sets httpOnly session cookie. */
export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;
export const LoginResponse = z.object({ user: UserSchema });
export type LoginResponse = z.infer<typeof LoginResponse>;

/** GET /api/auth/me */
export const MeResponse = z.object({ user: UserSchema });
export type MeResponse = z.infer<typeof MeResponse>;

/** PATCH /api/auth/me — update the signed-in user's profile (display name).
 *  An empty/whitespace name clears it (falls back to the username). */
export const UpdateProfileRequest = z.object({
  displayName: z.string().max(80).nullable(),
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
export const UpdateProfileResponse = z.object({ user: UserSchema });
export type UpdateProfileResponse = z.infer<typeof UpdateProfileResponse>;

/** Browser-facing deployment posture. Safe to expose before authentication. */
export const DeploymentModeSchema = z.enum([
  'builtin-tls',
  'external-tls',
  'private-http',
  'development',
]);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const DeploymentStatusSchema = z.object({
  mode: DeploymentModeSchema,
  transport: z.enum(['https', 'http']),
  /** Present only when the operator deliberately selected an unencrypted mode. */
  warning: z.string().nullable(),
});
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

/**
 * GET /api/auth/status — public first-run probe. `setupRequired` is true until
 * the installation owner exists, so the sign-in UI can show first-run setup
 * vs. "sign in" without a destructive POST.
 */
export const AuthStatusResponse = z.object({
  setupRequired: z.boolean(),
  setupTokenRequired: z.boolean(),
  deployment: DeploymentStatusSchema,
});
export type AuthStatusResponse = z.infer<typeof AuthStatusResponse>;
