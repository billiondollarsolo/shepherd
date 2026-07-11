/**
 * AgentdBootstrap — ships, launches, and upgrades the flock-agentd binary on a
 * remote node over SSH so the node stays a "dumb courier" (just SSH; no manual
 * install). This is the REAL risk of the daemon design (distribution/upgrade,
 * not the PTY code — see docs/flock-agentd-design.md §bootstrap), so it is its
 * own unit-tested unit, decoupled from ssh2 via the {@link AgentdHost} seam.
 *
 * ensureRunning():
 *   1. detect the node's os/arch (`uname -sm`);
 *   2. compare the installed daemon version (`<bin> version`) to the expected one;
 *   3. if missing/mismatched, sftp the arch-matched local binary and atomically
 *      move it into place;
 *   4. (re)launch under systemd --user + linger (survives logout/reboot), falling
 *      back to a detached nohup process when a user systemd bus is unavailable;
 *   5. return the loopback addr the orchestrator should `direct-tcpip` to.
 *
 * Idempotent: a node that already runs the right version just re-asserts the
 * service. The daemon listens on loopback ONLY; SSH provides authn+crypto.
 */
import type { AgentdHost } from './ssh-agentd-host.js';

/** A node platform the daemon is built for. */
export interface AgentdPlatform {
  os: string; // 'linux' (v1 Linux-only)
  arch: string; // 'amd64' | 'arm64'
}

/** Resolves a LOCAL path to the daemon binary built for a node's platform. */
export interface AgentdBinaryProvider {
  /** Local filesystem path to the `flock-agentd` built for `platform`. */
  resolve(platform: AgentdPlatform): Promise<string>;
}

export interface AgentdBootstrapConfig {
  /** Expected daemon version (matches the shipped binary's `version` output). */
  version: string;
  /** Loopback port the daemon listens on (reached via direct-tcpip). */
  port: number;
  /** Optional shared secret (defense-in-depth atop SSH). */
  secret?: string;
  /** Supplies the arch-matched local binary to upload. */
  binaries: AgentdBinaryProvider;
  /** Remote install dir, `$HOME`-relative. Default `.flock/agentd`. */
  remoteDir?: string;
  logger?: { warn(msg: string): void };
}

/** Where the orchestrator should open its direct-tcpip channel. */
export interface AgentdEndpoint {
  host: string; // always loopback on the node
  port: number;
}

const DEFAULT_REMOTE_DIR = '.flock/agentd';

export class AgentdBootstrap {
  private readonly version: string;
  private readonly port: number;
  private readonly secret?: string;
  private readonly binaries: AgentdBinaryProvider;
  private readonly remoteDir: string;
  private readonly logger: { warn(msg: string): void };

  constructor(cfg: AgentdBootstrapConfig) {
    this.version = cfg.version;
    this.port = cfg.port;
    this.secret = cfg.secret;
    this.binaries = cfg.binaries;
    this.remoteDir = cfg.remoteDir ?? DEFAULT_REMOTE_DIR;
    this.logger = cfg.logger ?? {
      warn(msg) {
        // eslint-disable-next-line no-console
        console.warn(`[agentd-bootstrap] ${msg}`);
      },
    };
  }

  /**
   * Ensure the right daemon is installed + running; return its loopback addr.
   * A healthy daemon of the EXPECTED version is left untouched (so reconnecting
   * never kills running sessions) — it is only (re)launched when the binary was
   * upgraded or nothing is listening on the port yet.
   */
  async ensureRunning(host: AgentdHost): Promise<AgentdEndpoint> {
    const installed = await this.installedVersion(host);
    const upgraded = installed !== this.version;
    if (upgraded) {
      const platform = await this.detectPlatform(host);
      const local = await this.binaries.resolve(platform);
      await this.install(host, local);
    }
    const running = await this.isListening(host);
    if (upgraded || !running) {
      await this.launch(host);
    }
    return { host: '127.0.0.1', port: this.port };
  }

  /**
   * True when the daemon's loopback port already accepts connections. Probed
   * via the SSH channel itself (direct-tcpip) rather than shelling out to `ss`,
   * so it's accurate regardless of the node's userland (minimal containers may
   * lack `ss`/procfs net). A successful channel open == something is listening.
   */
  private async isListening(host: AgentdHost): Promise<boolean> {
    try {
      const ch = await host.forwardOut('127.0.0.1', this.port);
      ch.destroy();
      return true;
    } catch {
      return false;
    }
  }

  /** `$HOME`-relative remote binary path (the daemon lives next to its state). */
  private get binPath(): string {
    return `$HOME/${this.remoteDir}/flock-agentd`;
  }

  /** Detect the node's os/arch via `uname`, normalised to Go's GOOS/GOARCH. */
  private async detectPlatform(host: AgentdHost): Promise<AgentdPlatform> {
    const res = await host.exec('uname -s; uname -m');
    const [rawOs = '', rawArch = ''] = res.stdout.trim().split('\n');
    const os = rawOs.trim().toLowerCase(); // 'linux'
    const arch = normalizeArch(rawArch.trim());
    if (!os || !arch) {
      throw new Error(
        `agentd: could not detect node platform (uname: ${JSON.stringify(res.stdout)})`,
      );
    }
    return { os, arch };
  }

  /** Read the installed daemon version, or '' if absent/unreadable. */
  private async installedVersion(host: AgentdHost): Promise<string> {
    try {
      const res = await host.exec(`${this.binPath} version 2>/dev/null`);
      if (res.code !== 0) return '';
      return res.stdout.trim();
    } catch {
      return '';
    }
  }

  /** Upload the binary to a temp path and atomically move it into place. */
  private async install(host: AgentdHost, localPath: string): Promise<void> {
    const dir = `$HOME/${this.remoteDir}`;
    await this.run(host, `mkdir -p ${dir}`);
    // sftp can't expand $HOME, so resolve it first; upload to .new then rename
    // (atomic on the same fs) so a concurrent launch never sees a partial binary.
    const home = (await host.exec('printf %s "$HOME"')).stdout.trim();
    if (!home) throw new Error('agentd: could not resolve remote $HOME for upload');
    const remoteFinal = `${home}/${this.remoteDir}/flock-agentd`;
    const remoteTmp = `${remoteFinal}.new`;
    await host.uploadFile(localPath, remoteTmp, 0o700);
    await this.run(
      host,
      `mv -f ${shq(remoteTmp)} ${shq(remoteFinal)} && chmod 0700 ${shq(remoteFinal)}`,
    );
  }

  /**
   * (Re)launch the daemon. Tries systemd --user (with linger), which survives
   * logout AND reboot. If no user systemd bus is available it falls back to a
   * detached nohup process. Idempotent: restart starts-or-restarts.
   *
   * T26 — REBOOT-SURVIVAL CAVEAT for the nohup fallback: a nohup'd daemon does
   * NOT survive a node reboot. There is no proactive re-launch — the orchestrator's
   * periodic health probe (`probeRemote`) is CONNECT-ONLY and will not relaunch a
   * dead daemon; it only flips the node dot to "down". Recovery is LAZY: the next
   * `clientForRemote` (i.e. the next session create/open on that node) calls
   * `ensureRunning`, which re-ships + relaunches the daemon. So after a reboot a
   * nohup-fallback node shows "down" until the next session activity re-bootstraps
   * it. To get automatic reboot survival, ensure the node user has a systemd --user
   * bus (the linger path is preferred and used whenever available). A periodic
   * orchestrator-driven re-assert could close the gap (future work; pairs with
   * T2/T10 supervision).
   */
  private async launch(host: AgentdHost): Promise<void> {
    const script = this.launchScript();
    const res = await host.exec(script);
    if (res.code !== 0) {
      this.logger.warn(
        `launch script exited ${res.code}: ${res.stderr.trim() || res.stdout.trim()}`,
      );
      throw new Error(`agentd: failed to launch daemon on node (code ${res.code})`);
    }
  }

  /**
   * A single POSIX script that installs+(re)starts the daemon via systemd --user
   * when available, else nohup. Kept as one exec so launch is one round-trip and
   * the fallback decision happens node-side.
   */
  private launchScript(): string {
    const dir = `$HOME/${this.remoteDir}`;
    const stateDir = `${dir}/state`;
    const bin = this.binPath;
    const envFile = `${dir}/agentd.env`;
    const hasSecret = !!this.secret;
    // The secret goes in a 0600 EnvironmentFile, NOT inline in the unit: a systemd
    // unit file is 0644 (readable by any local user), so an inline
    // `Environment=FLOCK_AGENTD_SECRET=…` would leak the secret to every account on
    // the node. The env file is chmod 600 (owner-only).
    const writeEnvFile = hasSecret
      ? `printf 'FLOCK_AGENTD_SECRET=%s\\n' ${shq(this.secret as string)} > "${envFile}"; chmod 600 "${envFile}"`
      : `rm -f "${envFile}" 2>/dev/null || true`;
    const envFileLine = hasSecret ? `EnvironmentFile=${envFile}` : '';
    // nohup fallback: source the same 0600 file so the daemon inherits the secret.
    const nohupSource = hasSecret ? `set -a; . "${envFile}"; set +a; ` : '';
    const serveArgs = `serve --addr 127.0.0.1:${this.port} --state-dir ${stateDir}`;
    // Heredocs intentionally unquoted where we want $HOME expansion in the unit.
    return [
      'set -e',
      `mkdir -p ${stateDir}`,
      writeEnvFile,
      'if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then',
      '  loginctl enable-linger "$USER" >/dev/null 2>&1 || true',
      '  mkdir -p "$HOME/.config/systemd/user"',
      '  cat > "$HOME/.config/systemd/user/flock-agentd.service" <<UNIT',
      '[Unit]',
      'Description=Flock agent daemon',
      'After=default.target',
      '[Service]',
      `ExecStart=${bin} ${serveArgs}`,
      'Restart=always',
      'RestartSec=2',
      envFileLine,
      '[Install]',
      'WantedBy=default.target',
      'UNIT',
      '  systemctl --user daemon-reload',
      '  systemctl --user enable flock-agentd.service >/dev/null 2>&1 || true',
      '  systemctl --user restart flock-agentd.service',
      'else',
      '  # No user systemd bus: detached fallback (does not survive reboot).',
      // Kill an existing daemon by EXACT process name (comm), NOT cmdline: a
      // `pkill -f` pattern would also match THIS shell (its argv contains the
      // script text "flock-agentd serve") and kill the launch mid-run.
      '  pkill -x flock-agentd >/dev/null 2>&1 || true',
      // Fully detach so the daemon outlives the SSH session: setsid → new
      // session (no controlling tty), nohup → ignore SIGHUP, all std FDs closed
      // so the exec channel closes immediately. On a real host PID 1 adopts it;
      // it survives logout. (A node WITH user-systemd uses the branch above, which
      // additionally survives reboot via linger.)
      `  ${nohupSource}setsid nohup ${bin} ${serveArgs} </dev/null >"${dir}/agentd.log" 2>&1 &`,
      '  sleep 1', // let it bind before we return (the caller forwards next)
      'fi',
    ].join('\n');
  }

  /** exec a command that must succeed, surfacing a useful error if it doesn't. */
  private async run(host: AgentdHost, command: string): Promise<void> {
    const res = await host.exec(command);
    if (res.code !== 0) {
      throw new Error(
        `agentd: remote command failed (code ${res.code}): ${command}\n${res.stderr.trim()}`,
      );
    }
  }
}

/** Normalise `uname -m` to Go's GOARCH. */
function normalizeArch(machine: string): string {
  switch (machine) {
    case 'x86_64':
    case 'amd64':
      return 'amd64';
    case 'aarch64':
    case 'arm64':
      return 'arm64';
    default:
      return ''; // unsupported (v1)
  }
}

/** POSIX single-quote escaping for literal shell args. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
