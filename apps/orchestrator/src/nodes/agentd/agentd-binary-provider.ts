/**
 * FsAgentdBinaryProvider — resolves the local path to a prebuilt flock-agentd
 * binary for a node's platform. Binaries are named `flock-agentd-<os>-<arch>`
 * (matching Go's GOOS/GOARCH) in a directory built by CI (or `make` in dev):
 *
 *   dist/flock-agentd-linux-amd64
 *   dist/flock-agentd-linux-arm64
 *
 * Keeping resolution behind {@link AgentdBinaryProvider} lets the bootstrap unit
 * test inject a fake, and lets prod swap in an embedded-asset or download
 * provider later without touching the bootstrap logic.
 */
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

import type { AgentdBinaryProvider, AgentdPlatform } from './agentd-bootstrap.js';

export class FsAgentdBinaryProvider implements AgentdBinaryProvider {
  constructor(private readonly dir: string) {}

  async resolve(platform: AgentdPlatform): Promise<string> {
    const file = path.join(this.dir, `flock-agentd-${platform.os}-${platform.arch}`);
    try {
      await access(file, constants.R_OK);
    } catch {
      throw new Error(
        `agentd: no binary for ${platform.os}/${platform.arch} at ${file} ` +
          `(build with: cd agentd && make dist)`,
      );
    }
    return file;
  }
}
