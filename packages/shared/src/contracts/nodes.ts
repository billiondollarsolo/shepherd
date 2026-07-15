import { z } from 'zod';
import {
  AgentTypeEnum,
  ConnectionStatusEnum,
  IsoTimestamp,
  NodeKindEnum,
  NodeSchema,
  SshAuthMethodEnum,
  Uuid,
} from '../domain.js';
import { AgentdCompatibilitySchema } from '../agentd-compatibility.js';

// --- nodes -----------------------------------------------------------------

/** POST /api/nodes — register a local or SSH node. */
/** A node's environment variables: a flat map of name → value. */
export const NodeEnv = z.record(z.string(), z.string());
export type NodeEnv = z.infer<typeof NodeEnv>;

export const CreateNodeRequest = z
  .object({
    name: z.string().min(1),
    kind: NodeKindEnum,
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    sshUser: z.string().min(1).optional(),
    /** Auth method for ssh nodes (defaults to 'key' when omitted). */
    sshAuthMethod: SshAuthMethodEnum.optional(),
    /** Plaintext private key; orchestrator encrypts at rest, never echoes it. */
    sshPrivateKey: z.string().min(1).optional(),
    /** Optional passphrase for an encrypted private key (encrypted at rest). */
    sshPassphrase: z.string().min(1).optional(),
    /** Plaintext password for password auth; encrypted at rest, never echoed. */
    sshPassword: z.string().min(1).optional(),
    /** Per-node env vars merged (under) the launch env for every agent here;
     *  encrypted at rest, never echoed in the Node list. */
    env: NodeEnv.optional(),
    /** Optional pool/group label. */
    pool: z.string().nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind !== 'ssh') return;
    // host + user are always required for ssh.
    for (const f of ['host', 'sshUser'] as const) {
      if (!val[f]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f],
          message: `${f} is required for ssh nodes`,
        });
      }
    }
    // The credential required depends on the auth method (key is the default).
    if (val.sshAuthMethod === 'password') {
      if (!val.sshPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sshPassword'],
          message: 'sshPassword is required for password auth',
        });
      }
    } else if (!val.sshPrivateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sshPrivateKey'],
        message: 'sshPrivateKey is required for key auth',
      });
    }
  });
export type CreateNodeRequest = z.infer<typeof CreateNodeRequest>;

/**
 * PATCH /api/nodes/:id — edit a node. Every field is optional (a partial update);
 * `kind` is immutable (delete + re-add to change it). Credential fields left out
 * KEEP the existing value (SSH clients behave the same), so the form can show
 * blank "leave to keep" inputs. Switching `sshAuthMethod` to a method with no
 * stored credential requires sending that credential.
 */
export const UpdateNodeRequest = z
  .object({
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    sshUser: z.string().min(1).optional(),
    sshAuthMethod: SshAuthMethodEnum.optional(),
    sshPrivateKey: z.string().min(1).optional(),
    sshPassphrase: z.string().min(1).optional(),
    sshPassword: z.string().min(1).optional(),
    /** Replace the node's env vars wholesale ({} clears them); omitted = keep. */
    env: NodeEnv.optional(),
    /** Set/clear the pool label (null clears; omitted = keep). */
    pool: z.string().nullable().optional(),
  })
  .strict();
export type UpdateNodeRequest = z.infer<typeof UpdateNodeRequest>;

export const NodeResponse = z.object({ node: NodeSchema });
export type NodeResponse = z.infer<typeof NodeResponse>;

/** GET /api/nodes/:id/env — the node's decrypted env, for the editor (cookie-authed). */
export const NodeEnvResponse = z.object({ env: NodeEnv });
export type NodeEnvResponse = z.infer<typeof NodeEnvResponse>;
export const ListNodesResponse = z.object({ nodes: z.array(NodeSchema) });
export type ListNodesResponse = z.infer<typeof ListNodesResponse>;

/** GET /api/nodes/:id/status */
export const NodeStatusResponse = z.object({
  id: Uuid,
  connectionStatus: ConnectionStatusEnum,
  lastSeenAt: IsoTimestamp.nullable(),
});
export type NodeStatusResponse = z.infer<typeof NodeStatusResponse>;

export const NodePreflightCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['pass', 'warning', 'fail']),
  detail: z.string().min(1),
});
export type NodePreflightCheck = z.infer<typeof NodePreflightCheckSchema>;

/** Read-only readiness report for a local or SSH execution node. */
export const NodePreflightResponseSchema = z.object({
  nodeId: Uuid,
  generatedAt: IsoTimestamp,
  ready: z.boolean(),
  daemonCompatibility: AgentdCompatibilitySchema,
  checks: z.array(NodePreflightCheckSchema),
});
export type NodePreflightResponse = z.infer<typeof NodePreflightResponseSchema>;

// --- node coding-tool and Docker capabilities -----------------------------

/** Installable coding tools Shepherd can launch as first-class or basic agents. */
export const NodeToolIdEnum = z.enum([
  'claude',
  'codex',
  'opencode',
  'gemini',
  'grok',
  'aider',
  'cursor-agent',
  'amp',
]);
export type NodeToolId = z.infer<typeof NodeToolIdEnum>;

export const NodeToolIntegrationEnum = z.enum(['first_class', 'basic']);
export type NodeToolIntegration = z.infer<typeof NodeToolIntegrationEnum>;

export const NodeToolCapabilitySchema = z
  .object({
    id: NodeToolIdEnum,
    agentType: AgentTypeEnum,
    label: z.string().min(1),
    binary: z.string().min(1),
    integration: NodeToolIntegrationEnum,
    installed: z.boolean(),
    path: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
    installSupported: z.boolean(),
    installReason: z.string().min(1).nullable(),
  })
  .strict();
export type NodeToolCapability = z.infer<typeof NodeToolCapabilitySchema>;

export const NodeDockerCapabilitySchema = z
  .object({
    installed: z.boolean(),
    version: z.string().min(1).nullable(),
    daemonRunning: z.boolean(),
    agentAccess: z.boolean(),
    accessMode: z.enum(['none', 'system_acl', 'rootless', 'unmanaged']),
    installSupported: z.boolean(),
    accessManagementSupported: z.boolean(),
    reason: z.string().min(1).nullable(),
  })
  .strict();
export type NodeDockerCapability = z.infer<typeof NodeDockerCapabilitySchema>;

/** Read-only inventory used by Node details and session-launch guidance. */
export const NodeCapabilitiesResponseSchema = z
  .object({
    nodeId: Uuid,
    generatedAt: IsoTimestamp,
    tools: z.array(NodeToolCapabilitySchema),
    docker: NodeDockerCapabilitySchema,
  })
  .strict();
export type NodeCapabilitiesResponse = z.infer<typeof NodeCapabilitiesResponseSchema>;

export const InstallNodeToolRequestSchema = z
  .object({ tool: NodeToolIdEnum, confirm: z.literal('INSTALL') })
  .strict();
export type InstallNodeToolRequest = z.infer<typeof InstallNodeToolRequestSchema>;

export const InstallNodeToolResponseSchema = z
  .object({
    nodeId: Uuid,
    tool: NodeToolIdEnum,
    capability: NodeToolCapabilitySchema,
    summary: z.string().min(1).max(2_000),
  })
  .strict();
export type InstallNodeToolResponse = z.infer<typeof InstallNodeToolResponseSchema>;

export const NodeDockerActionEnum = z.enum([
  'install',
  'enable_agent_access',
  'disable_agent_access',
]);
export type NodeDockerAction = z.infer<typeof NodeDockerActionEnum>;

export const ConfigureNodeDockerRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('install'), confirm: z.literal('INSTALL DOCKER') }).strict(),
  z
    .object({
      action: z.literal('enable_agent_access'),
      confirm: z.literal('DOCKER IS ROOT EQUIVALENT'),
    })
    .strict(),
  z
    .object({
      action: z.literal('disable_agent_access'),
      confirm: z.literal('DOCKER IS ROOT EQUIVALENT'),
    })
    .strict(),
]);
export type ConfigureNodeDockerRequest = z.infer<typeof ConfigureNodeDockerRequestSchema>;

export const ConfigureNodeDockerResponseSchema = z
  .object({
    nodeId: Uuid,
    action: NodeDockerActionEnum,
    docker: NodeDockerCapabilitySchema,
    summary: z.string().min(1).max(2_000),
  })
  .strict();
export type ConfigureNodeDockerResponse = z.infer<typeof ConfigureNodeDockerResponseSchema>;

// --- node filesystem browse (pick a working dir without typing it) ----------

/**
 * GET /api/nodes/:id/fs?path=... — list directories under `path` ON the node, so
 * the UI can offer a path browser instead of a blind text field (works for local
 * AND remote/ssh nodes, over that node's transport). Directories only (you pick a
 * working dir / repo root). `path` defaults to the node's home dir when omitted.
 */
export const ListNodeDirQuery = z.object({ path: z.string().optional() });
export type ListNodeDirQuery = z.infer<typeof ListNodeDirQuery>;

/** A single directory entry returned by the path browser. */
export const NodeDirEntrySchema = z.object({
  name: z.string(),
  /** Absolute path of the entry on the node. */
  path: z.string(),
});
export type NodeDirEntry = z.infer<typeof NodeDirEntrySchema>;

/**
 * GET /api/nodes/:id/fs response. `path` is the absolute, resolved directory
 * being listed; `parent` is its parent (null at filesystem root); `entries` are
 * the child directories (sorted, dotfiles excluded by default).
 */
export const ListNodeDirResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(NodeDirEntrySchema),
});
export type ListNodeDirResponse = z.infer<typeof ListNodeDirResponse>;

// --- node file tree + read/write (VS Code–style file browser) ---------------

/** Whether a tree entry is a directory or a regular file. */
export const NodeFsKind = z.enum(['dir', 'file']);
export type NodeFsKind = z.infer<typeof NodeFsKind>;

/** One entry (dir OR file) from the file-tree listing. */
export const NodeFsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: NodeFsKind,
});
export type NodeFsEntry = z.infer<typeof NodeFsEntry>;

/** GET /api/nodes/:id/fs/tree?path=... — dirs AND files under `path` (one level). */
export const NodeFsTreeResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(NodeFsEntry),
});
export type NodeFsTreeResponse = z.infer<typeof NodeFsTreeResponse>;

/**
 * GET /api/nodes/:id/fs/file?path=... — read a file's bytes (base64, capped).
 * `truncated` is true when the file was larger than the read cap. The client
 * decodes `contentBase64`; if it isn't valid UTF-8 it renders as binary.
 */
export const NodeFileReadResponse = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
  contentBase64: z.string(),
});
export type NodeFileReadResponse = z.infer<typeof NodeFileReadResponse>;

/**
 * PUT /api/nodes/:id/fs/file — write bytes to `path` (base64). Serves both the
 * in-browser editor (save) and drag-and-drop upload. The parent dir must exist.
 */
export const NodeFileWriteRequest = z.object({
  path: z.string().min(1),
  contentBase64: z.string(),
});
export type NodeFileWriteRequest = z.infer<typeof NodeFileWriteRequest>;

export const NodeFileWriteResponse = z.object({ ok: z.literal(true), path: z.string() });
export type NodeFileWriteResponse = z.infer<typeof NodeFileWriteResponse>;

/**
 * POST /api/nodes/:id/fs/mkdir — create ONE new directory `name` inside the
 * existing `parent` dir (the path picker's "New folder"). `name` is a single path
 * component — no separators or `.`/`..` (enforced server-side too) so it can't
 * escape `parent`. Like the file write, this is an authenticated node filesystem
 * mutation.
 */
export const NodeMakeDirRequest = z.object({
  parent: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !n.includes('/') && n !== '.' && n !== '..' && n.trim() === n, {
      message: 'name must be a single path component (no "/", "." or "..")',
    }),
});
export type NodeMakeDirRequest = z.infer<typeof NodeMakeDirRequest>;

export const NodeMakeDirResponse = z.object({ path: z.string() });
export type NodeMakeDirResponse = z.infer<typeof NodeMakeDirResponse>;
