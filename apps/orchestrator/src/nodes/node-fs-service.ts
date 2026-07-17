/**
 * NodeFsService — a read-only directory browser ON a node (local or remote/ssh),
 * so the UI can offer a path picker instead of a blind text field when choosing a
 * project's working dir.
 *
 *   GET /api/nodes/:id/fs?path=...  →  { path, parent, entries[] }
 *
 * Like the diff service, this runs a command ON THE NODE via its
 * {@link NodeTransport}; the node stays a DUMB COURIER (PRD §6.4): the
 * orchestrator hands it the exact argv and the node runs nothing else. It is
 * directory-only (you pick a working dir / repo root) and excludes dotfiles by
 * default. It is on-demand (a UI interaction), never the live status path.
 *
 * Safety: the user-supplied path is passed as a POSITIONAL ARGUMENT to `sh -c`
 * (`$1`), never interpolated into the script text, so it cannot inject shell
 * (the same `sh -c <script> <name> <path>` form works across the local and ssh
 * transports). The listing is also confined to directories the node user can
 * read; an unreadable/missing path surfaces as a clean error.
 */
import type {
  AgentType,
  ListNodeDirResponse,
  NodeDirEntry,
  NodeFileReadResponse,
  NodeFsEntry,
  NodeFsKind,
  NodeFsTreeResponse,
} from '@flock/shared';

import type { NodeCommandTransport } from './transport/transport.js';
import {
  CODEX_MODEL_LIST_REQUESTS,
  isNodeDiscoveredModels,
  parseAgyModels,
  parseCodexModelList,
  staticModelsFor,
} from './agent-models-catalog.js';

/** Thrown when the node has no live transport (unreachable ssh node) → 422. */
export class NodeUnreachableError extends Error {
  constructor(readonly nodeId: string) {
    super(`Node ${nodeId} is not reachable.`);
    this.name = 'NodeUnreachableError';
  }
}

/** Thrown when the path can't be listed (missing / not a dir / no perms) → 422. */
export class NodePathError extends Error {
  constructor(
    readonly nodeId: string,
    readonly detail: string,
  ) {
    super(`Cannot list path on node ${nodeId}: ${detail}`);
    this.name = 'NodePathError';
  }
}

/** Resolves the live {@link NodeTransport} for a node id (async; may connect). */
export interface NodeFsTransportResolver {
  transportForNode(nodeId: string): Promise<NodeCommandTransport | null>;
}

export interface NodeFsServiceOptions {
  /** Max ms the listing command may run before being killed. Default 10s. */
  timeoutMs?: number;
}

/** Sentinel the script prints when `cd` into the target fails. */
const ERR_MARKER = '__FLOCK_FS_ERR__';

/**
 * The portable listing script. `$1` is the requested path (defaults to the node
 * user's $HOME). It `cd`s in, prints the RESOLVED absolute path (`pwd`), then the
 * names of the immediate sub-directories (one per line, dotfiles excluded via the
 * trailing-slash filter on `ls -1p`). Directory-only by design.
 *
 * Exported so the unit test asserts the exact argv (the node is a dumb courier;
 * the argv IS the contract).
 */
export const FS_LIST_SCRIPT =
  `target="\${1:-$HOME}"; cd "$target" 2>/dev/null || { echo ${ERR_MARKER}; exit 1; }; ` +
  `pwd; ls -1p 2>/dev/null | grep '/$' || true`;

/** Build the argv passed to the transport: `sh -c <script> flock-fs <path>`. */
export function fsListArgv(path: string | undefined): string[] {
  // `flock-fs` becomes $0 inside `sh -c`; the path becomes $1. Passing the path
  // positionally (not inside the script text) prevents shell injection.
  return ['sh', '-c', FS_LIST_SCRIPT, 'flock-fs', path ?? ''];
}

/**
 * Like {@link FS_LIST_SCRIPT} but lists BOTH directories AND files (the VS
 * Code–style file tree). `-A` includes dotfiles (but not `.`/`..`); `-p` appends
 * a trailing `/` to directories so the parser can tag each entry's kind.
 */
export const FS_TREE_SCRIPT =
  `target="\${1:-$HOME}"; cd "$target" 2>/dev/null || { echo ${ERR_MARKER}; exit 1; }; ` +
  `pwd; ls -1Ap 2>/dev/null || true`;

export function fsTreeArgv(path: string | undefined): string[] {
  return ['sh', '-c', FS_TREE_SCRIPT, 'flock-fs', path ?? ''];
}

/**
 * Read a file's bytes as base64, capped to `$2` bytes (`head -c`). Prints the
 * true size on the first line (so the caller can flag truncation), then the
 * base64 of the first `cap` bytes. base64 keeps binary safe over the text exec
 * channel; the client decodes + decides utf8-vs-binary.
 */
export const FS_READ_SCRIPT =
  `f="$1"; cap="$2"; [ -f "$f" ] || { echo ${ERR_MARKER}; exit 1; }; ` +
  `wc -c < "$f" 2>/dev/null || echo 0; head -c "$cap" "$f" | base64`;

export function fsReadArgv(path: string, cap: number): string[] {
  return ['sh', '-c', FS_READ_SCRIPT, 'flock-fs', path, String(cap)];
}

/**
 * Write stdin (base64) to `$1`, decoding it back to bytes. The parent dir must
 * already exist (we don't `mkdir -p` — writes are scoped to an existing tree).
 * Serves both the editor save and drag-and-drop upload.
 */
export const FS_WRITE_SCRIPT = `f="$1"; d=$(dirname "$f"); [ -d "$d" ] || { echo ${ERR_MARKER}; exit 1; }; base64 -d > "$f"`;

export function fsWriteArgv(path: string): string[] {
  return ['sh', '-c', FS_WRITE_SCRIPT, 'flock-fs', path];
}

/**
 * Create ONE new directory `$2` inside the EXISTING parent dir `$1` (the path
 * picker's "New folder"). `cd`s into the parent (must exist), rejects a `name`
 * that isn't a single component (`/`, `.`, `..`) so it can't escape the parent,
 * then `mkdir` (NOT `-p` → fails clearly if it already exists) and prints the new
 * dir's resolved absolute path. Both args are positional ($1/$2), never spliced
 * into the script text → injection-safe (same form as the other fs scripts).
 */
export const FS_MKDIR_SCRIPT =
  `parent="$1"; name="$2"; cd "$parent" 2>/dev/null || { echo ${ERR_MARKER}; exit 1; }; ` +
  `case "$name" in ''|*/*|.|..) echo ${ERR_MARKER}; exit 1;; esac; ` +
  `mkdir "$name" 2>/dev/null || { echo ${ERR_MARKER}; exit 1; }; cd "$name" && pwd`;

export function fsMkdirArgv(parent: string, name: string): string[] {
  return ['sh', '-c', FS_MKDIR_SCRIPT, 'flock-fs', parent, name];
}

/**
 * The one-shot `codex app-server` model-discovery script: feed the ndjson JSON-RPC
 * requests ($1 = initialize, $2 = model/list) into `codex app-server` on stdin and
 * capture its stdout responses. `codex app-server` SHUTS DOWN on stdin EOF before it
 * flushes its responses, so we must hold stdin open: after writing the two requests we
 * `sleep` to keep the pipe open while codex processes them and streams stdout. `timeout`
 * then BOUNDS the whole exchange — it kills codex and we parse whatever responses
 * arrived (`timeout`'s 124 exit is expected and harmless; we key off stdout, not the
 * exit code). stderr (the bubblewrap warning) is dropped. Both requests are passed
 * POSITIONALLY, never spliced into the script text → injection-safe (same form as the
 * fs scripts).
 */
export const CODEX_MODELS_SCRIPT =
  `{ printf '%s\n' "$1" "$2"; sleep 6; } | timeout 8 codex app-server 2>/dev/null`;

/** Build the argv for codex model discovery: `sh -c <script> flock-models <init> <list>`. */
export function codexModelsArgv(): string[] {
  return [
    'sh',
    '-c',
    CODEX_MODELS_SCRIPT,
    'flock-models',
    CODEX_MODEL_LIST_REQUESTS[0],
    CODEX_MODEL_LIST_REQUESTS[1],
  ];
}

/** POSIX dirname of an absolute path, or null at the filesystem root. */
function parentOf(absPath: string): string | null {
  if (absPath === '/' || absPath === '') return null;
  const trimmed = absPath.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Max bytes returned by a file read (larger files are truncated). */
export const FS_READ_CAP_BYTES = 2_000_000;
/** Max bytes accepted by a file write / upload. */
export const FS_WRITE_CAP_BYTES = 5_000_000;

export class NodeFsService {
  private readonly transports: NodeFsTransportResolver;
  private readonly timeoutMs: number;

  constructor(deps: { transports: NodeFsTransportResolver; options?: NodeFsServiceOptions }) {
    this.transports = deps.transports;
    this.timeoutMs = deps.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * List the immediate sub-directories of `path` on the node (default: the node
   * user's home dir). Returns the resolved absolute path, its parent (null at
   * root), and the child directories sorted by name.
   *
   * Throws {@link NodeUnreachableError} (→422) when the node has no transport and
   * {@link NodePathError} (→422) when the path can't be read.
   */
  async listDir(nodeId: string, path?: string): Promise<ListNodeDirResponse> {
    const transport = await this.transports.transportForNode(nodeId);
    if (!transport) {
      throw new NodeUnreachableError(nodeId);
    }

    let stdout: string;
    let exitCode: number | null;
    let timedOut: boolean;
    try {
      const result = await transport.exec(fsListArgv(path), { timeoutMs: this.timeoutMs });
      stdout = result.stdout;
      exitCode = result.exitCode;
      timedOut = result.timedOut;
    } catch (err) {
      throw new NodePathError(nodeId, err instanceof Error ? err.message : 'listing failed.');
    }

    if (timedOut) throw new NodePathError(nodeId, 'directory listing timed out.');

    const lines = stdout.split('\n');
    const first = (lines.shift() ?? '').trim();
    if (exitCode !== 0 || first === ERR_MARKER || first === '') {
      throw new NodePathError(
        nodeId,
        path ? `cannot open "${path}".` : 'cannot open home directory.',
      );
    }

    const resolved = first; // absolute path from `pwd`
    const base = resolved === '/' ? '' : resolved.replace(/\/+$/, '');
    const entries: NodeDirEntry[] = lines
      .map((l) => l.replace(/\/+$/, '').trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name, path: `${base}/${name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { path: resolved, parent: parentOf(resolved), entries };
  }

  /**
   * List the immediate children (directories AND files) of `path` for the file
   * tree. Mirrors {@link listDir} but tags each entry's {@link NodeFsKind} and
   * keeps dotfiles. Dirs sort before files, each alphabetically.
   */
  async listTree(nodeId: string, path?: string): Promise<NodeFsTreeResponse> {
    const transport = await this.transports.transportForNode(nodeId);
    if (!transport) throw new NodeUnreachableError(nodeId);

    let stdout: string;
    let exitCode: number | null;
    let timedOut: boolean;
    try {
      const r = await transport.exec(fsTreeArgv(path), { timeoutMs: this.timeoutMs });
      ({ stdout, exitCode, timedOut } = r);
    } catch (err) {
      throw new NodePathError(nodeId, err instanceof Error ? err.message : 'listing failed.');
    }
    if (timedOut) throw new NodePathError(nodeId, 'directory listing timed out.');

    const lines = stdout.split('\n');
    const first = (lines.shift() ?? '').trim();
    if (exitCode !== 0 || first === ERR_MARKER || first === '') {
      throw new NodePathError(
        nodeId,
        path ? `cannot open "${path}".` : 'cannot open home directory.',
      );
    }
    const resolved = first;
    const base = resolved === '/' ? '' : resolved.replace(/\/+$/, '');
    const entries: NodeFsEntry[] = lines
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim().length > 0)
      .map((raw) => {
        const isDir = raw.endsWith('/');
        const name = raw.replace(/\/+$/, '');
        return { name, path: `${base}/${name}`, kind: (isDir ? 'dir' : 'file') as NodeFsKind };
      })
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      );
    return { path: resolved, parent: parentOf(resolved), entries };
  }

  /**
   * Read a file's bytes (base64, capped to {@link FS_READ_CAP_BYTES}). Throws
   * {@link NodePathError} (→422) when the path isn't a readable regular file.
   */
  async readFile(nodeId: string, path: string): Promise<NodeFileReadResponse> {
    const transport = await this.transports.transportForNode(nodeId);
    if (!transport) throw new NodeUnreachableError(nodeId);

    let stdout: string;
    let exitCode: number | null;
    let timedOut: boolean;
    try {
      const r = await transport.exec(fsReadArgv(path, FS_READ_CAP_BYTES), {
        timeoutMs: this.timeoutMs,
      });
      ({ stdout, exitCode, timedOut } = r);
    } catch (err) {
      throw new NodePathError(nodeId, err instanceof Error ? err.message : 'read failed.');
    }
    if (timedOut) throw new NodePathError(nodeId, 'file read timed out.');

    const nl = stdout.indexOf('\n');
    const sizeLine = (nl === -1 ? stdout : stdout.slice(0, nl)).trim();
    if (exitCode !== 0 || sizeLine === ERR_MARKER || sizeLine === '') {
      throw new NodePathError(nodeId, `cannot read "${path}" (not a file?).`);
    }
    const size = Number.parseInt(sizeLine, 10) || 0;
    // base64 body (strip whitespace/newlines the encoder may have inserted).
    const contentBase64 = (nl === -1 ? '' : stdout.slice(nl + 1)).replace(/\s+/g, '');
    return { path, size, truncated: size > FS_READ_CAP_BYTES, contentBase64 };
  }

  /**
   * Write base64 bytes to `path` (editor save / upload). Rejects payloads over
   * {@link FS_WRITE_CAP_BYTES}. Throws {@link NodePathError} (→422) on failure.
   */
  async writeFile(nodeId: string, path: string, contentBase64: string): Promise<void> {
    const approxBytes = Math.floor((contentBase64.length * 3) / 4);
    if (approxBytes > FS_WRITE_CAP_BYTES) {
      throw new NodePathError(nodeId, `file too large (max ${FS_WRITE_CAP_BYTES} bytes).`);
    }
    const transport = await this.transports.transportForNode(nodeId);
    if (!transport) throw new NodeUnreachableError(nodeId);

    let stdout: string;
    let stderr: string;
    let exitCode: number | null;
    let timedOut: boolean;
    try {
      const r = await transport.exec(fsWriteArgv(path), {
        input: contentBase64,
        timeoutMs: this.timeoutMs,
      });
      ({ stdout, stderr, exitCode, timedOut } = r);
    } catch (err) {
      throw new NodePathError(nodeId, err instanceof Error ? err.message : 'write failed.');
    }
    if (timedOut) throw new NodePathError(nodeId, 'file write timed out.');
    if (exitCode !== 0 || stdout.includes(ERR_MARKER)) {
      throw new NodePathError(nodeId, stderr.trim() || `cannot write "${path}" (parent missing?).`);
    }
  }

  /**
   * Create a new directory `name` inside the existing `parent` dir. Returns the
   * created dir's resolved absolute path. `name` must be a single path component
   * (validated here AND in the script) so it can't escape `parent`. Throws
   * {@link NodePathError} (→422) when the parent is missing, the name is invalid,
   * or the directory already exists / can't be created.
   */
  async makeDir(nodeId: string, parent: string, name: string): Promise<{ path: string }> {
    const clean = name.trim();
    if (!clean || clean.includes('/') || clean === '.' || clean === '..') {
      throw new NodePathError(nodeId, 'invalid folder name.');
    }
    const transport = await this.transports.transportForNode(nodeId);
    if (!transport) throw new NodeUnreachableError(nodeId);

    let stdout: string;
    let exitCode: number | null;
    let timedOut: boolean;
    try {
      const r = await transport.exec(fsMkdirArgv(parent, clean), { timeoutMs: this.timeoutMs });
      ({ stdout, exitCode, timedOut } = r);
    } catch (err) {
      throw new NodePathError(nodeId, err instanceof Error ? err.message : 'mkdir failed.');
    }
    if (timedOut) throw new NodePathError(nodeId, 'mkdir timed out.');

    const resolved = (stdout.split('\n').shift() ?? '').trim();
    if (exitCode !== 0 || resolved === ERR_MARKER || resolved === '') {
      throw new NodePathError(
        nodeId,
        `cannot create "${clean}" in "${parent}" (exists or no permission?).`,
      );
    }
    return { path: resolved };
  }

  /**
   * The models an agent CLI offers on this node, for the model picker. Two agents are
   * discovered live on the node: antigravity (`agy models`, one model per line) and
   * codex (a one-shot `codex app-server` initialize → model/list JSON-RPC exchange —
   * the DYNAMIC list from the tool itself). Every other agent returns its curated
   * static catalog without touching the node.
   *
   * Discovery is best-effort: antigravity degrades to [] on any failure, and codex
   * degrades to its STATIC catalog whenever the exchange yields no models (codex
   * returns none until authenticated, or the node/CLI errored/timed out) — so the
   * picker always has something and never blocks the dialog.
   */
  async listAgentModels(
    nodeId: string,
    agentType: AgentType,
  ): Promise<{ models: string[]; source: 'node' | 'static' }> {
    if (!isNodeDiscoveredModels(agentType)) {
      return { models: staticModelsFor(agentType), source: 'static' };
    }
    const transport = await this.transports.transportForNode(nodeId);
    if (!transport) {
      // No live transport → codex still shows its static catalog; antigravity has none.
      return agentType === 'codex'
        ? { models: staticModelsFor('codex'), source: 'static' }
        : { models: [], source: 'node' };
    }

    if (agentType === 'codex') {
      try {
        // `timeout` may kill codex (it does not exit on EOF): parse stdout regardless
        // of exitCode/timedOut, since the model/list response arrives before the bound.
        const r = await transport.exec(codexModelsArgv(), { timeoutMs: this.timeoutMs });
        const models = parseCodexModelList(r.stdout);
        if (models.length > 0) return { models, source: 'node' };
      } catch {
        /* fall through to the static catalog. */
      }
      return { models: staticModelsFor('codex'), source: 'static' };
    }

    // antigravity (`agy models`).
    try {
      const r = await transport.exec(['agy', 'models'], { timeoutMs: this.timeoutMs });
      if (r.timedOut || r.exitCode !== 0) return { models: [], source: 'node' };
      return { models: parseAgyModels(r.stdout), source: 'node' };
    } catch {
      return { models: [], source: 'node' };
    }
  }
}
