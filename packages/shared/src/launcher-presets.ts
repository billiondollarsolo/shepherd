/**
 * Launch presets for two-click agent launch (Phase 2).
 */
import { z } from 'zod';
import { AgentTypeEnum, SessionPermissionModeEnum } from './domain.js';

export const LauncherPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  agentType: AgentTypeEnum,
  permissionMode: SessionPermissionModeEnum.optional(),
  systemPrompt: z.string().max(8000).optional(),
});
export type LauncherPreset = z.infer<typeof LauncherPresetSchema>;

export const LauncherPresetsPayloadSchema = z.object({
  presets: z.array(LauncherPresetSchema),
  updatedAt: z.string().optional(),
});
export type LauncherPresetsPayload = z.infer<typeof LauncherPresetsPayloadSchema>;

/** Built-in presets shipped with the product. */
export const BUILTIN_LAUNCHER_PRESETS: readonly LauncherPreset[] = [
  { id: 'builtin-claude', name: 'Claude Code', agentType: 'claude-code' },
  { id: 'builtin-codex', name: 'Codex', agentType: 'codex' },
  { id: 'builtin-opencode', name: 'OpenCode', agentType: 'opencode' },
  { id: 'builtin-gemini', name: 'Gemini', agentType: 'gemini' },
  { id: 'builtin-grok', name: 'Grok', agentType: 'grok' },
  { id: 'builtin-terminal', name: 'Shell', agentType: 'terminal' },
];
