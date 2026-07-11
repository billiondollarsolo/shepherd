import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { nodes, secrets } from '../../db/schema.js';
import type { SecretStore } from '../../secrets/secret-store.js';

const SECRET_NONCE_BYTES = 12;
const MIN_CREDENTIAL_CHARS = 32;

export interface NodeControlIdentity {
  /** Identity asserted by this daemon during the authenticated handshake. */
  nodeId: string;
  /** Random per-node MAC key. Never serialize or log this object. */
  credential: string;
}

export interface NodeControlCredentialsDeps {
  db: Database;
  secrets: SecretStore;
  /** Protected local daemon key file, readable only by the control identity. */
  localCredentialFile?: string;
  /** Protected stable local daemon identity file. */
  localIdentityFile?: string;
  /** Explicit insecure source-development bridge; never configure in production. */
  developmentLocal?: NodeControlIdentity;
}

/**
 * Owns per-node agentd authentication material. Remote credentials are generated
 * once and encrypted in Postgres. The local credential originates in agentd's
 * protected state volume, is mirrored encrypted at rest, and must agree with the
 * database thereafter. A mismatch fails closed instead of silently re-enrolling.
 */
export class NodeControlCredentials {
  private readonly pending = new Map<string, Promise<NodeControlIdentity>>();

  constructor(private readonly deps: NodeControlCredentialsDeps) {}

  forNode(nodeId: string, kind: 'local' | 'ssh'): Promise<NodeControlIdentity> {
    const existing = this.pending.get(nodeId);
    if (existing) return existing;
    const pending = this.resolve(nodeId, kind).finally(() => this.pending.delete(nodeId));
    this.pending.set(nodeId, pending);
    return pending;
  }

  private async resolve(nodeId: string, kind: 'local' | 'ssh'): Promise<NodeControlIdentity> {
    const [node] = await this.deps.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node || node.kind !== kind) throw new Error(`agentd: unknown ${kind} node ${nodeId}`);

    const local = kind === 'local' ? await this.readLocalIdentity() : undefined;
    if (node.agentdCredentialRef) {
      const credential = await this.decrypt(node.agentdCredentialRef);
      if (local && !safeStringEqual(local.credential, credential)) {
        throw new Error(
          'agentd: protected local credential does not match its encrypted database record',
        );
      }
      return { nodeId: local?.nodeId ?? nodeId, credential };
    }

    const credential = local?.credential ?? randomBytes(32).toString('base64url');
    const secretId = await this.store(credential);
    const [claimed] = await this.deps.db
      .update(nodes)
      .set({ agentdCredentialRef: secretId })
      .where(and(eq(nodes.id, nodeId), isNull(nodes.agentdCredentialRef)))
      .returning({ id: nodes.id });

    if (!claimed) {
      // Another orchestrator path won the enrollment race. Remove our orphaned
      // secret and re-read the authoritative record.
      await this.deps.db.delete(secrets).where(eq(secrets.id, secretId));
      return this.resolve(nodeId, kind);
    }
    return { nodeId: local?.nodeId ?? nodeId, credential };
  }

  private async readLocalIdentity(): Promise<NodeControlIdentity> {
    const credentialFile = this.deps.localCredentialFile;
    const identityFile = this.deps.localIdentityFile;
    if (!credentialFile || !identityFile) {
      if (this.deps.developmentLocal) return this.deps.developmentLocal;
      throw new Error('agentd: protected local credential and identity files are required');
    }
    const [credential, nodeId] = await Promise.all([
      readFile(credentialFile, 'utf8').then((value) => value.trim()),
      readFile(identityFile, 'utf8').then((value) => value.trim()),
    ]);
    if (credential.length < MIN_CREDENTIAL_CHARS) {
      throw new Error('agentd: protected local credential is too short');
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nodeId)) {
      throw new Error('agentd: protected local node identity is invalid');
    }
    return { nodeId, credential };
  }

  private async store(credential: string): Promise<string> {
    const envelope = this.deps.secrets.encrypt(credential);
    const [secret] = await this.deps.db
      .insert(secrets)
      .values({
        kind: 'agentd_control',
        ciphertext: Buffer.from(envelope.ciphertext),
        nonce: Buffer.concat([Buffer.from(envelope.nonce), Buffer.from(envelope.authTag)]),
        keyVersion: envelope.keyVersion,
      })
      .returning({ id: secrets.id });
    if (!secret) throw new Error('agentd: failed to persist node control credential');
    return secret.id;
  }

  private async decrypt(secretId: string): Promise<string> {
    const [secret] = await this.deps.db
      .select()
      .from(secrets)
      .where(and(eq(secrets.id, secretId), eq(secrets.kind, 'agentd_control')))
      .limit(1);
    if (!secret) throw new Error('agentd: node control credential is missing');
    const nonce = new Uint8Array(secret.nonce);
    const value = await this.deps.secrets.decryptToString(
      {
        ciphertext: new Uint8Array(secret.ciphertext),
        nonce: nonce.slice(0, SECRET_NONCE_BYTES),
        authTag: nonce.slice(SECRET_NONCE_BYTES),
        keyVersion: secret.keyVersion,
      },
      { secretId },
    );
    if (value.length < MIN_CREDENTIAL_CHARS) {
      throw new Error('agentd: stored node control credential is invalid');
    }
    return value;
  }
}

function safeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
