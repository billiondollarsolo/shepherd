import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createVault, defaultRollbackPath, restoreVault, verifyVault } from './vault.js';

function loadMasterKeyFiles(env = process.env): void {
  for (const [name, file] of Object.entries(env)) {
    if (!name.startsWith('FLOCK_MASTER_KEY') || !name.endsWith('_FILE') || !file) continue;
    const target = name.slice(0, -'_FILE'.length);
    if (!env[target]) env[target] = readFileSync(file, 'utf8').trim();
  }
}

function passwordFromProtectedInput(env = process.env): Buffer {
  const file = env.FLOCK_VAULT_PASSWORD_FILE;
  const fdRaw = env.FLOCK_VAULT_PASSWORD_FD;
  if (!file && !fdRaw) {
    throw new Error(
      'Set FLOCK_VAULT_PASSWORD_FILE or FLOCK_VAULT_PASSWORD_FD (for example FD 3); passwords are never accepted as command arguments.',
    );
  }
  const raw = file ? readFileSync(file) : readFileSync(Number(fdRaw));
  const password = Buffer.from(raw.toString('utf8').replace(/[\r\n]+$/, ''));
  raw.fill(0);
  if (password.length < 12) throw new Error('Vault password must be at least 12 bytes');
  return password;
}

function value(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runVaultCli(args = process.argv.slice(2)): Promise<void> {
  loadMasterKeyFiles();
  const [command, input] = args;
  if (!command || !input || !['create', 'verify', 'restore'].includes(command)) {
    throw new Error(
      'Usage: vault <create OUTPUT|verify ARCHIVE|restore ARCHIVE> [--rollback-output PATH] [--allow-active]',
    );
  }
  const password = passwordFromProtectedInput();
  try {
    if (command === 'create') {
      const manifest = await createVault({ output: input, password });
      console.log(`Created and verified Shepherd vault ${input} (${manifest.createdAt})`);
      return;
    }
    if (command === 'verify') {
      const manifest = await verifyVault(input, password);
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    const rollbackOutput = value(args, '--rollback-output') ?? defaultRollbackPath(input);
    const result = await restoreVault({
      input,
      password,
      rollbackOutput,
      allowActiveConnections: args.includes('--allow-active'),
    });
    console.log(
      `Restore complete. Pre-restore vault: ${rollbackOutput}. Rollback database retained as ${result.rollbackDatabase}.`,
    );
  } finally {
    password.fill(0);
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  runVaultCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
