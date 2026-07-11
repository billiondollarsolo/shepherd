import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Resolve the daemon version from the explicit override or shipped VERSION file. */
export function resolveAgentdVersion(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.FLOCK_AGENTD_VERSION;
  if (configured?.trim()) return configured.trim();
  for (const relative of ['../../agentd/VERSION', '../agentd/VERSION', './agentd/VERSION']) {
    try {
      const version = readFileSync(path.resolve(cwd, relative), 'utf8').trim();
      if (version) return version;
    } catch {
      // Try the next supported source-tree/image location.
    }
  }
  throw new Error(
    'Cannot resolve the agentd version: FLOCK_AGENTD_VERSION is unset and agentd/VERSION ' +
      `was not found from cwd ${cwd}. Set FLOCK_AGENTD_VERSION or ship agentd/VERSION.`,
  );
}
