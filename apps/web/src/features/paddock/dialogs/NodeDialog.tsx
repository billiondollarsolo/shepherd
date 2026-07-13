import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { HardDrive } from 'lucide-react';
import type { NodeKind, SshAuthMethod } from '@flock/shared';
import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '../../../components/ui';
import { usePaddock } from '../../../store/paddock';
import { useCreateNode, useNodes, useUpdateNode } from '../../../data/queries';
import { getNodeEnv } from '../../../data/treeApi';
import { DialogField as Field } from './DialogField';
import { formatEnvText, parseEnvText } from './envText';

export function NodeDialog(): JSX.Element {
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const closeDialog = usePaddock((s) => s.closeDialog);
  const editNodeId = usePaddock((s) => s.dialogNodeId);
  const { data: allNodes = [] } = useNodes();
  const editing = useMemo(
    () => allNodes.find((n) => n.id === editNodeId) ?? null,
    [allNodes, editNodeId],
  );

  // In edit mode the kind is fixed; credential fields start blank ("leave to keep").
  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<NodeKind>(editing?.kind ?? 'local');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(editing?.port ? String(editing.port) : '22');
  const [sshUser, setSshUser] = useState(editing?.sshUser ?? '');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(editing?.sshAuthMethod ?? 'key');
  const [key, setKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  // #3c pool + #3a env (any node kind). Env prefills from the server on edit.
  const [pool, setPool] = useState(editing?.pool ?? '');
  const [envText, setEnvText] = useState('');
  const [origEnvText, setOrigEnvText] = useState('');
  const busy = createNode.isPending || updateNode.isPending;

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    void getNodeEnv(editing.id)
      .then((r) => {
        if (!alive) return;
        const text = formatEnvText(r.env);
        setEnvText(text);
        setOrigEnvText(text);
      })
      .catch(() => {
        /* leave blank; saving without touching env won't clear it */
      });
    return () => {
      alive = false;
    };
  }, [editing]);

  async function onKeyFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setKey(await file.text());
  }

  // For key auth a private key is required (on create, or a blank-keep on edit);
  // for password auth a password is required likewise.
  const credReady = editing
    ? true // edit: blank credential = keep existing
    : authMethod === 'password'
      ? password.trim().length > 0
      : key.trim().length > 0;
  const sshReady = host.trim() && sshUser.trim() && credReady;
  const canSubmit = !!name.trim() && (kind === 'local' || sshReady);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      if (editing) {
        // Diff against the original; only send what changed (+ non-blank creds).
        const patch: Record<string, unknown> = {};
        if (name.trim() !== editing.name) patch.name = name.trim();
        if (pool.trim() !== (editing.pool ?? '')) patch.pool = pool.trim() || null;
        // Only touch env if the textarea changed (prevents a not-yet-loaded prefill
        // from silently clearing it).
        if (envText !== origEnvText) patch.env = parseEnvText(envText);
        if (editing.kind === 'ssh') {
          if (host.trim() !== (editing.host ?? '')) patch.host = host.trim();
          const portNum = Number(port) || 22;
          if (portNum !== (editing.port ?? 22)) patch.port = portNum;
          if (sshUser.trim() !== (editing.sshUser ?? '')) patch.sshUser = sshUser.trim();
          if (authMethod !== (editing.sshAuthMethod ?? 'key')) patch.sshAuthMethod = authMethod;
          if (authMethod === 'key') {
            if (key.trim()) patch.sshPrivateKey = key;
            if (passphrase.trim()) patch.sshPassphrase = passphrase;
          } else if (password.trim()) {
            patch.sshPassword = password;
          }
        }
        await updateNode.mutateAsync({ id: editing.id, input: patch });
      } else {
        // pool + env apply to any kind.
        const env = parseEnvText(envText);
        const extra = {
          ...(pool.trim() ? { pool: pool.trim() } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        if (kind === 'local') {
          await createNode.mutateAsync({ name: name.trim(), kind, ...extra });
        } else {
          await createNode.mutateAsync({
            name: name.trim(),
            kind,
            host: host.trim(),
            port: Number(port) || 22,
            sshUser: sshUser.trim(),
            sshAuthMethod: authMethod,
            ...(authMethod === 'key'
              ? { sshPrivateKey: key, ...(passphrase.trim() ? { sshPassphrase: passphrase } : {}) }
              : { sshPassword: password }),
            ...extra,
          });
        }
      }
      closeDialog();
    } catch {
      /* error toast handled by the mutation; keep the dialog open to retry */
    }
  }

  const keepHint = editing ? ' Leave blank to keep the current one.' : '';

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <HardDrive className="size-4 text-flock-accent" /> {editing ? 'Edit node' : 'Add node'}
        </DialogTitle>
        <DialogDescription>
          A node is an execution target — this machine, or a remote host over SSH.
        </DialogDescription>
      </DialogHeader>

      <Field label="Name" htmlFor="node-name">
        <Input
          id="node-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="build-box"
          autoFocus
          required
        />
      </Field>

      {/* Kind is immutable once created (delete + re-add to change it). */}
      {editing ? (
        <Field label="Kind" htmlFor="node-kind">
          <Input
            id="node-kind"
            value={kind === 'ssh' ? 'Remote (SSH)' : 'Local (this orchestrator)'}
            disabled
          />
        </Field>
      ) : (
        <Field label="Kind" htmlFor="node-kind">
          <Select value={kind} onValueChange={(v) => setKind(v as NodeKind)}>
            <SelectTrigger id="node-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local (this orchestrator)</SelectItem>
              <SelectItem value="ssh">Remote (SSH)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      {kind === 'ssh' && (
        <>
          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <Field label="Host" htmlFor="node-host">
              <Input
                id="node-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="10.0.0.5 / box.internal"
                required
              />
            </Field>
            <Field label="Port" htmlFor="node-port">
              <Input
                id="node-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <Field label="SSH user" htmlFor="node-user">
            <Input
              id="node-user"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="ubuntu"
              required
            />
          </Field>

          <Field label="Authentication" htmlFor="node-auth">
            <Select value={authMethod} onValueChange={(v) => setAuthMethod(v as SshAuthMethod)}>
              <SelectTrigger id="node-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="key">Private key</SelectItem>
                <SelectItem value="password">Password</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {authMethod === 'key' ? (
            <>
              <Field
                label="Private key"
                htmlFor="node-key"
                hint={`Paste a key or upload a file (id_ed25519, .pem). Encrypted at rest, never shown again.${keepHint}`}
              >
                <Textarea
                  id="node-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    editing ? '•••••• (keeping current key)' : '-----BEGIN OPENSSH PRIVATE KEY-----'
                  }
                />
              </Field>
              <div className="flex items-center gap-2">
                <input
                  id="node-key-file"
                  type="file"
                  onChange={onKeyFile}
                  className="block w-full text-2xs text-flock-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-flock-surface-2 file:px-3 file:py-1.5 file:text-xs file:text-flock-ink-primary hover:file:bg-flock-surface-3"
                />
              </div>
              <Field
                label="Key passphrase (optional)"
                htmlFor="node-passphrase"
                hint={`Only for an encrypted key.${keepHint}`}
              >
                <Input
                  id="node-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={editing ? '•••••• (unchanged)' : 'passphrase'}
                  autoComplete="off"
                />
              </Field>
            </>
          ) : (
            <Field
              label="Password"
              htmlFor="node-password"
              hint={`Encrypted at rest, never shown again.${keepHint}`}
            >
              <Input
                id="node-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={editing ? '•••••• (keeping current)' : 'password'}
                autoComplete="off"
              />
            </Field>
          )}
        </>
      )}

      <Field
        label="Pool (optional)"
        htmlFor="node-pool"
        hint="A group label to organize nodes (e.g. gpu, us-east)."
      >
        <Input
          id="node-pool"
          value={pool}
          onChange={(e) => setPool(e.target.value)}
          placeholder="ungrouped"
        />
      </Field>

      <Field
        label="Environment (optional)"
        htmlFor="node-env"
        hint="KEY=VALUE per line, merged into every agent launched on this node (a session's own vars win). Encrypted at rest."
      >
        <Textarea
          id="node-env"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={'HTTPS_PROXY=http://proxy:8080\nNODE_OPTIONS=--max-old-space-size=4096'}
          className="font-mono text-xs"
        />
      </Field>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeDialog}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !canSubmit}>
          {busy ? (editing ? 'Saving…' : 'Adding…') : editing ? 'Save changes' : 'Add node'}
        </Button>
      </DialogFooter>
    </form>
  );
}
