/**
 * NodeService — REST CRUD for execution-target nodes (spec §6, FR-N1/N2).
 *
 *   GET    /api/nodes        list nodes (mapped to the shared `Node`, NO secrets)
 *   POST   /api/nodes        register a `local` or `ssh` node
 *   DELETE /api/nodes/:id    remove a node (cascade), audited
 *
 * For an `ssh` node the supplied plaintext private key is encrypted at rest via
 * the {@link SecretStore} (AES-256-GCM, US-3/FR-A4/NFR-SEC2); only the resulting
 * `secrets` row id is stored in `nodes.ssh_key_ref`. The raw key is NEVER stored
 * in the nodes table and NEVER serialized back to a client — `rowToNode` only
 * exposes the opaque `sshKeyRef`.
 *
 * Persistence + listing is the requirement: creating an `ssh` node does NOT block
 * on a live SSH connect; its `connectionStatus` starts `disconnected` and is
 * driven later by the reconcile loop. A `local` node is `connected` immediately.
 *
 * Collaborators (db, secret store, audit logger) are injected so this service is
 * unit-testable without real Postgres or crypto-at-rest wiring. Postgres here is
 * the durable system of record, never the live status path (spec §6.6).
 */
import { eq } from 'drizzle-orm';

import type {
  CreateNodeRequest,
  Node as SharedNode,
  SshAuthMethod,
  UpdateNodeRequest,
} from '@flock/shared';

import type { AuditLogger } from '../audit/audit.js';
import type { Database } from '../db/client.js';
import { rowToNode } from '../db/mappers.js';
import { nodes, secrets } from '../db/schema.js';
import type { SecretStore } from '../secrets/secret-store.js';

/** Default SSH port when a caller omits one (spec §6 / common SSH default). */
export const DEFAULT_SSH_PORT = 22;

/** A user-correctable problem with an edit (e.g. password auth, no password) →
 * the route maps this to a 400 rather than a generic 500. */
export class NodeValidationError extends Error {}

/** SECRET_NONCE_BYTES — the GCM auth tag is appended to the nonce in `secrets`. */
const SECRET_NONCE_BYTES = 12;

/**
 * The SSH credential material for a node, stored as ONE encrypted JSON envelope
 * in the node's `secrets` row (never serialized to clients). `sshAuthMethod`
 * decides which field the connector uses: `password` for password auth, else
 * `privateKey` (+ optional `passphrase`). Bundling keeps a node to a single
 * secret and makes "edit, leave blank to keep" a decrypt-merge-reencrypt.
 */
export interface SshCredential {
  privateKey?: string;
  passphrase?: string;
  password?: string;
}

/**
 * Parse a decrypted credential secret into an {@link SshCredential}. Bundled
 * secrets are JSON; a legacy secret (a raw private-key string written before
 * bundling) is treated as `{ privateKey }` so old nodes keep connecting.
 */
export function parseCredential(plaintext: string): SshCredential {
  try {
    const obj = JSON.parse(plaintext) as Record<string, unknown>;
    if (obj && typeof obj === 'object') {
      const pick = (k: string): string | undefined =>
        typeof obj[k] === 'string' && obj[k] ? (obj[k] as string) : undefined;
      return {
        privateKey: pick('privateKey'),
        passphrase: pick('passphrase'),
        password: pick('password'),
      };
    }
  } catch {
    /* not JSON → legacy raw-key string */
  }
  return { privateKey: plaintext };
}

/** Build the credential bundle a CREATE request implies (key vs password auth). */
function credentialFromCreate(input: CreateNodeRequest): SshCredential {
  if (input.sshAuthMethod === 'password') {
    return { password: input.sshPassword };
  }
  return { privateKey: input.sshPrivateKey, passphrase: input.sshPassphrase };
}

/** Context carried with an audited node action (actor + network origin). */
export interface NodeActionContext {
  /** The acting user (from the authed session cookie). */
  userId: string;
  /** Source IP of the request, when available. */
  ip?: string | null;
}

export interface NodeServiceDeps {
  db: Database;
  /** Encrypts an SSH private key at rest; only the secret id is persisted. */
  secrets: SecretStore;
  audit: AuditLogger;
  /**
   * Optional lifecycle hooks so creating/removing an `ssh` node triggers a real
   * managed connection (wired to the NodeConnectionManager in index.ts). Kept
   * optional so the service stays unit-testable without the connection layer.
   * `onSshNodeCreated` is fire-and-forget: a connect failure must not fail the
   * create (the node persists `disconnected`/`error` and the supervisor retries).
   */
  onSshNodeCreated?: (nodeId: string) => void;
  onNodeRemoved?: (nodeId: string) => void;
  /**
   * Fired after an `ssh` node's connection parameters change (host/user/port/
   * credential/auth-method) so the manager can drop the stale link and reconnect
   * with the new settings. Fire-and-forget, like `onSshNodeCreated`.
   */
  onSshNodeUpdated?: (nodeId: string) => void;
}

export class NodeService {
  private readonly db: Database;
  private readonly secrets: SecretStore;
  private readonly audit: AuditLogger;
  private readonly onSshNodeCreated?: (nodeId: string) => void;
  private readonly onNodeRemoved?: (nodeId: string) => void;
  private readonly onSshNodeUpdated?: (nodeId: string) => void;

  constructor(deps: NodeServiceDeps) {
    this.db = deps.db;
    this.secrets = deps.secrets;
    this.audit = deps.audit;
    this.onSshNodeCreated = deps.onSshNodeCreated;
    this.onNodeRemoved = deps.onNodeRemoved;
    this.onSshNodeUpdated = deps.onSshNodeUpdated;
  }

  /**
   * Encrypt an SSH credential bundle at rest (AES-256-GCM, NFR-SEC2) and persist
   * it as a `secrets` row; returns the secret id to store in `nodes.ssh_key_ref`.
   * The nonce column stores `nonce || authTag` so the envelope round-trips.
   */
  private async storeCredential(cred: SshCredential): Promise<string> {
    const envelope = this.secrets.encrypt(JSON.stringify(cred));
    const [secret] = await this.db
      .insert(secrets)
      .values({
        kind: 'ssh_key',
        ciphertext: Buffer.from(envelope.ciphertext),
        nonce: Buffer.concat([Buffer.from(envelope.nonce), Buffer.from(envelope.authTag)]),
        keyVersion: envelope.keyVersion,
      })
      .returning();
    if (!secret) {
      throw new Error('Failed to persist ssh credential secret.');
    }
    return secret.id;
  }

  /**
   * Decrypt a node's credential bundle. Backward-compatible: a legacy secret that
   * is a raw private-key string (pre-bundling) is read as `{ privateKey }`.
   * Returns `{}` if the secret is missing/unreadable so an edit can still proceed.
   */
  private async loadCredential(secretId: string): Promise<SshCredential> {
    const [secret] = await this.db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1);
    if (!secret) return {};
    const nonceBytes = new Uint8Array(secret.nonce);
    let plaintext: string;
    try {
      plaintext = await this.secrets.decryptToString(
        {
          ciphertext: new Uint8Array(secret.ciphertext),
          nonce: nonceBytes.slice(0, SECRET_NONCE_BYTES),
          authTag: nonceBytes.slice(SECRET_NONCE_BYTES),
          keyVersion: secret.keyVersion,
        },
        { secretId: secret.id },
      );
    } catch {
      return {};
    }
    return parseCredential(plaintext);
  }

  /**
   * Encrypt a node's env-var map ({KEY:value,…}) at rest as a `secrets` row and
   * return the id to store in `nodes.env_ref`. Same envelope shape as credentials.
   */
  private async storeEnv(env: Record<string, string>): Promise<string> {
    const envelope = this.secrets.encrypt(JSON.stringify(env));
    const [secret] = await this.db
      .insert(secrets)
      .values({
        kind: 'node_env',
        ciphertext: Buffer.from(envelope.ciphertext),
        nonce: Buffer.concat([Buffer.from(envelope.nonce), Buffer.from(envelope.authTag)]),
        keyVersion: envelope.keyVersion,
      })
      .returning();
    if (!secret) throw new Error('Failed to persist node env secret.');
    return secret.id;
  }

  /** Decrypt a node env secret to a string→string map; {} if missing/unreadable. */
  private async loadEnv(secretId: string): Promise<Record<string, string>> {
    const [secret] = await this.db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1);
    if (!secret) return {};
    const nonceBytes = new Uint8Array(secret.nonce);
    try {
      const plaintext = await this.secrets.decryptToString(
        {
          ciphertext: new Uint8Array(secret.ciphertext),
          nonce: nonceBytes.slice(0, SECRET_NONCE_BYTES),
          authTag: nonceBytes.slice(SECRET_NONCE_BYTES),
          keyVersion: secret.keyVersion,
        },
        { secretId: secret.id },
      );
      const obj = JSON.parse(plaintext) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return {};
    }
  }

  /**
   * The decrypted env-var map for a node (for the agent launch env merge), or {}
   * when the node has none / is unknown. Never throws — a launch must not fail
   * because env is missing.
   */
  async envForNode(nodeId: string): Promise<Record<string, string>> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row?.envRef) return {};
    return this.loadEnv(row.envRef);
  }

  /** The node's env map for the editor (GET /api/nodes/:id/env); null if unknown. */
  async getEnv(nodeId: string): Promise<Record<string, string> | null> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row) return null;
    return row.envRef ? this.loadEnv(row.envRef) : {};
  }

  /** List all nodes as the shared `Node` shape (no secret material). */
  async listNodes(): Promise<SharedNode[]> {
    const rows = await this.db.select().from(nodes);
    return rows.map(rowToNode);
  }

  /**
   * Create a node. For `local`: persist `connected`, no SSH fields. For `ssh`:
   * encrypt the private key, store the secret id in `ssh_key_ref`, persist
   * host/port(default 22)/sshUser with `connectionStatus = 'disconnected'`.
   * Writes a `node_add` audit row. The raw key is never persisted/echoed.
   */
  async createNode(input: CreateNodeRequest, ctx: NodeActionContext): Promise<SharedNode> {
    let sshKeyRef: string | null = null;
    let sshAuthMethod: SshAuthMethod | null = null;

    if (input.kind === 'ssh') {
      sshAuthMethod = input.sshAuthMethod ?? 'key';
      const cred = credentialFromCreate(input);
      // Guard explicitly rather than assert so we never persist an empty
      // credential (the shared superRefine already requires the right field).
      if (sshAuthMethod === 'password' ? !cred.password : !cred.privateKey) {
        throw new Error('an ssh credential (private key or password) is required.');
      }
      sshKeyRef = await this.storeCredential(cred);
    }

    // Per-node env (#3a) + pool (#3c) apply to any node kind.
    const envRef =
      input.env && Object.keys(input.env).length > 0 ? await this.storeEnv(input.env) : null;

    const [row] = await this.db
      .insert(nodes)
      .values({
        name: input.name,
        kind: input.kind,
        host: input.kind === 'ssh' ? (input.host ?? null) : null,
        port: input.kind === 'ssh' ? (input.port ?? DEFAULT_SSH_PORT) : null,
        sshUser: input.kind === 'ssh' ? (input.sshUser ?? null) : null,
        sshKeyRef,
        sshAuthMethod,
        envRef,
        pool: input.pool ?? null,
        // local nodes are reachable immediately; ssh nodes connect lazily.
        connectionStatus: input.kind === 'local' ? 'connected' : 'disconnected',
        createdBy: ctx.userId,
      })
      .returning();
    if (!row) {
      throw new Error('Failed to persist node record.');
    }

    const node = rowToNode(row);

    // Append the security-relevant audit row (FR-A3). Off the live path; a failure
    // must not break node creation, so it is best-effort.
    try {
      await this.audit.recordNodeAdd({
        nodeId: node.id,
        userId: ctx.userId,
        ip: ctx.ip ?? null,
        detail: { kind: node.kind, name: node.name },
      });
    } catch {
      /* swallow — create succeeds regardless (FR-A3 best-effort here). */
    }

    // Fire-and-forget: kick off the managed SSH connection (status will flip on
    // the node row as it connects). A failure never fails the create.
    if (node.kind === 'ssh' && this.onSshNodeCreated) {
      this.onSshNodeCreated(node.id);
    }

    return node;
  }

  /**
   * Edit a node (PATCH). Returns the updated `Node`, or `null` when the id is
   * unknown. `kind` is immutable. Credential fields left out are KEPT (we
   * decrypt-merge-reencrypt), so the form can leave key/password blank to reuse
   * the stored ones. When host/user/port/credential/method change, fires
   * `onSshNodeUpdated` so the manager reconnects with the new settings. Throws
   * {@link NodeValidationError} (→ 400) if the chosen auth method has no
   * credential. Writes a `node_update` audit row (best-effort).
   */
  async updateNode(
    id: string,
    input: UpdateNodeRequest,
    ctx: NodeActionContext,
  ): Promise<SharedNode | null> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!row) return null;

    const patch: Partial<typeof nodes.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    // Per-node env (#3a) + pool (#3c) apply to any node kind. env replaces
    // wholesale: {} clears it (envRef → null), a non-empty map stores a new secret.
    if (input.env !== undefined) {
      patch.envRef = Object.keys(input.env).length > 0 ? await this.storeEnv(input.env) : null;
    }
    if (input.pool !== undefined) patch.pool = input.pool;

    // SSH connection params + credentials only apply to ssh nodes.
    let connChanged = false;
    if (row.kind === 'ssh') {
      if (input.host !== undefined) {
        patch.host = input.host;
        connChanged = true;
      }
      if (input.port !== undefined) {
        patch.port = input.port;
        connChanged = true;
      }
      if (input.sshUser !== undefined) {
        patch.sshUser = input.sshUser;
        connChanged = true;
      }

      const currentMethod = (row.sshAuthMethod as SshAuthMethod | null) ?? 'key';
      const nextMethod: SshAuthMethod = input.sshAuthMethod ?? currentMethod;
      const hasNewCred =
        input.sshPrivateKey !== undefined ||
        input.sshPassphrase !== undefined ||
        input.sshPassword !== undefined;
      const methodChanged =
        input.sshAuthMethod !== undefined && input.sshAuthMethod !== currentMethod;

      if (hasNewCred || methodChanged) {
        // Decrypt-merge-reencrypt: keep fields the user didn't resend (e.g. change
        // only the passphrase, keep the existing key).
        const existing = row.sshKeyRef ? await this.loadCredential(row.sshKeyRef) : {};
        const merged: SshCredential = { ...existing };
        if (input.sshPrivateKey !== undefined) merged.privateKey = input.sshPrivateKey;
        if (input.sshPassphrase !== undefined) merged.passphrase = input.sshPassphrase;
        if (input.sshPassword !== undefined) merged.password = input.sshPassword;

        if (nextMethod === 'password' ? !merged.password : !merged.privateKey) {
          throw new NodeValidationError(
            `a ${nextMethod === 'password' ? 'password' : 'private key'} is required for ${nextMethod} auth.`,
          );
        }
        patch.sshKeyRef = await this.storeCredential(merged);
        connChanged = true;
      }
      if (input.sshAuthMethod !== undefined) {
        patch.sshAuthMethod = input.sshAuthMethod;
        connChanged = true;
      }
    }

    if (Object.keys(patch).length === 0) {
      return rowToNode(row); // no-op edit
    }

    const [updated] = await this.db.update(nodes).set(patch).where(eq(nodes.id, id)).returning();
    if (!updated) return null;
    const node = rowToNode(updated);

    try {
      await this.audit.recordNodeUpdate({
        nodeId: id,
        userId: ctx.userId,
        ip: ctx.ip ?? null,
        detail: { fields: Object.keys(patch) },
      });
    } catch {
      /* swallow — update succeeds regardless (FR-A3 best-effort here). */
    }

    // Reconnect with the new settings (fire-and-forget) when they changed.
    if (node.kind === 'ssh' && connChanged && this.onSshNodeUpdated) {
      this.onSshNodeUpdated(node.id);
    }

    return node;
  }

  /**
   * Delete a node by id (cascades to its projects + sessions via FK, spec §6).
   * Returns true when a row was removed, false when the id was unknown. Writes a
   * `node_remove` audit row on a successful delete.
   */
  async deleteNode(id: string, ctx: NodeActionContext): Promise<boolean> {
    const [row] = await this.db.delete(nodes).where(eq(nodes.id, id)).returning();
    if (!row) {
      return false;
    }

    try {
      await this.audit.recordNodeRemove({
        nodeId: id,
        userId: ctx.userId,
        ip: ctx.ip ?? null,
        detail: { kind: row.kind, name: row.name },
      });
    } catch {
      /* swallow — delete succeeds regardless (FR-A3 best-effort here). */
    }

    if (this.onNodeRemoved) {
      this.onNodeRemoved(id);
    }

    return true;
  }

  /**
   * Ensure a single `local` node exists (boot seeding). Idempotent: if any
   * `local` node is already present this is a no-op and returns the existing one,
   * so the paddock tree is never empty but never accrues duplicates on restart.
   */
  async ensureLocalNode(): Promise<SharedNode> {
    const existing = await this.db.select().from(nodes).where(eq(nodes.kind, 'local')).limit(1);
    if (existing[0]) {
      return rowToNode(existing[0]);
    }

    const [row] = await this.db
      .insert(nodes)
      .values({ name: 'local', kind: 'local', connectionStatus: 'connected' })
      .returning();
    if (!row) {
      throw new Error('Failed to seed the local node.');
    }
    return rowToNode(row);
  }
}
