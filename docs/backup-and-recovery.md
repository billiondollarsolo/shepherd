# Backup and recovery

Shepherd vaults are password-encrypted, authenticated `.flockvault` archives containing a
consistent PostgreSQL custom-format dump and a strict manifest. The archive does not
contain the Shepherd master key, live processes, node filesystems, worktrees, TLS private
keys, or in-memory terminal scrollback.

The manifest inventories declared durable volumes and their disposition. `pgdata` is
captured by the vault. `flock_agent_home`, Caddy state, and the vault destination require
separate filesystem/storage backup when those categories matter to the installation;
agentd runtime identity/process state is reconciled rather than presented as a process
snapshot.

Back up the matching `secrets/flock_master_key` separately. A database vault without
that key cannot decrypt stored SSH credentials; a master key without the database does
not reproduce Shepherd state.

## Create and verify

Passwords are never accepted on the command line. Put the password in a `0600` file or
pass it through an already-open file descriptor:

```bash
install -m 0600 /dev/null /tmp/flock-vault-password
$EDITOR /tmp/flock-vault-password
docker compose exec -T orchestrator sh -lc \
  'FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault create /backups/flock.flockvault 3<&0' \
  < /tmp/flock-vault-password
docker compose exec -T orchestrator sh -lc \
  'FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault verify /backups/flock.flockvault 3<&0' \
  < /tmp/flock-vault-password
```

Compose mounts `FLOCK_BACKUP_DIR` (default `./backups`) at `/backups`; place that host
directory on storage outside the installation. Creation is atomic and refuses to
overwrite an existing vault: a failed dump, verification, or encryption removes only
its own partial output.
Verification authenticates the entire encrypted stream, validates the manifest,
recomputes the dump checksum, and asks `pg_restore` to parse the archive.

## Restore

Stop normal writes first. Restore refuses active database connections unless the
operator explicitly supplies `--allow-active`:

```bash
docker compose stop caddy web orchestrator
docker compose run --rm -T orchestrator sh -lc \
  'FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault restore /backups/flock.flockvault \
    --rollback-output /backups/pre-restore.flockvault 3<&0' \
  < /tmp/flock-vault-password
docker compose up -d
```

The restore process:

1. authenticates and structurally verifies the input;
2. checks the Shepherd major version and every required master-key version;
3. creates and verifies an encrypted pre-restore rollback vault;
4. restores into a new isolated database;
5. applies migrations and validates core tables;
6. atomically renames databases for cutover;
7. reverses the rename if post-cutover validation fails;
8. retains the prior database under the reported rollback name.

After restart, Shepherd reconciles session metadata with agentd. Session rows, Pens,
preferences, events, capabilities, and encrypted credential envelopes are durable;
running processes are not snapshotted by the vault.

## Validation schedule

- Create and verify a vault before every destructive migration or upgrade.
- Restore the latest vault into an isolated installation at least quarterly.
- Test the master-key copy at the same time; never print it into logs.
- Confirm login, node/project order, Pens, sessions, events, and encrypted SSH
  credential use after the drill.
- Retain at least one known-good vault from the prior Shepherd major version until the
  new version has passed its restore drill.
