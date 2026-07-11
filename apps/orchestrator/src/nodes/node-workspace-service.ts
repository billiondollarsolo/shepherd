/**
 * NodeWorkspaceService — workspace intelligence for a node directory, run ON THE
 * NODE via its transport (the node stays a dumb courier; the argv IS the
 * contract). Three capabilities, mirroring the best of hiveterm but for our
 * remote/multi-node model:
 *
 *   detectStack()  — which tech stacks a dir is (Node/Rust/Go/Python/…), by marker
 *                    files, so the paddock can badge projects + offer stack actions.
 *   listFiles()    — every tracked file (gitignore-aware via ripgrep, with git /
 *                    find fallbacks) for the fuzzy Quick-Open palette.
 *   search()       — Find-in-Files (ripgrep, grep fallback) with case/word/regex.
 *
 * All scripts pass the dir + query POSITIONALLY (never interpolated into the
 * script text) so there's no shell injection.
 */
import type { NodeTransport } from './transport/transport.js';
import type { NodeFsTransportResolver } from './node-fs-service.js';
import { NodePathError, NodeUnreachableError } from './node-fs-service.js';

const ERR = '__FLOCK_WS_ERR__';
const DEFAULT_TIMEOUT_MS = 15_000;

/** A detected stack tag for a directory. */
export interface StackInfo {
  /** Resolved absolute dir. */
  path: string;
  /** Detected stack ids, e.g. ['node','docker']. */
  stacks: string[];
  /** True when the dir is inside a git work tree. */
  gitRepo: boolean;
  /** True when HEAD resolves (the repo has ≥1 commit). Worktrees need a commit to
   *  branch off, so a freshly `git init`'d repo (unborn HEAD) is gitRepo but NOT
   *  gitHasCommits — the worktree toggle gates on THIS, not gitRepo. */
  gitHasCommits: boolean;
}

/** One Find-in-Files match. */
export interface SearchMatch {
  file: string; // path relative to the search root
  line: number;
  text: string;
}
export interface SearchResult {
  matches: SearchMatch[];
  /** True when results were capped (more matches exist). */
  truncated: boolean;
}
export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

// --- scripts (exported so the unit test pins the exact argv) ----------------

/** Detect stacks by marker files; echo one stack id per line after the abs path. */
export const STACK_SCRIPT =
  `cd "$1" 2>/dev/null || { echo ${ERR}; exit 1; }; pwd; ` +
  `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo __git__; ` +
  `git rev-parse --verify -q HEAD >/dev/null 2>&1 && echo __git_commits__; ` +
  `[ -f package.json ] && echo node; ` +
  `[ -f deno.json ] || [ -f deno.jsonc ] && echo deno; ` +
  `[ -f Cargo.toml ] && echo rust; ` +
  `[ -f go.mod ] && echo go; ` +
  `{ [ -f pyproject.toml ] || [ -f requirements.txt ] || [ -f setup.py ] || [ -f Pipfile ]; } && echo python; ` +
  `[ -f artisan ] && echo laravel; ` +
  `{ [ -f composer.json ] && [ ! -f artisan ]; } && echo php; ` +
  `{ [ -f bin/rails ] || [ -f config/application.rb ]; } && echo rails; ` +
  `{ [ -f Gemfile ] && [ ! -f bin/rails ] && [ ! -f config/application.rb ]; } && echo ruby; ` +
  `[ -f pom.xml ] && echo maven; ` +
  `{ [ -f build.gradle ] || [ -f build.gradle.kts ]; } && echo gradle; ` +
  `{ [ -f Dockerfile ] || [ -f docker-compose.yml ] || [ -f compose.yml ] || [ -f compose.yaml ]; } && echo docker; ` +
  `true`;
export function stackArgv(path: string): string[] {
  return ['sh', '-c', STACK_SCRIPT, 'flock-ws', path];
}

/** List files (gitignore-aware) for fuzzy open; `$2` caps the count. */
export const FILES_SCRIPT =
  `cd "$1" 2>/dev/null || { echo ${ERR}; exit 1; }; cap="\${2:-5000}"; ` +
  `if command -v rg >/dev/null 2>&1; then rg --files --hidden --glob '!.git' 2>/dev/null | head -n "$cap"; ` +
  `elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files 2>/dev/null | head -n "$cap"; ` +
  `else find . -type f -not -path '*/.git/*' 2>/dev/null | sed 's|^\\./||' | head -n "$cap"; fi`;
export function filesArgv(path: string, cap: number): string[] {
  return ['sh', '-c', FILES_SCRIPT, 'flock-ws', path, String(cap)];
}

/**
 * Find-in-Files. $1=dir $2=query $3=ignoreCase(0/1) $4=wholeWord(0/1)
 * $5=regex(0/1). ripgrep preferred (gitignore-aware), grep fallback. Capped.
 */
export const SEARCH_SCRIPT =
  `dir="$1"; q="$2"; ic="$3"; ww="$4"; rx="$5"; cd "$dir" 2>/dev/null || { echo ${ERR}; exit 1; }; ` +
  `if command -v rg >/dev/null 2>&1; then ` +
  `args="--line-number --no-heading --color never -M 300"; ` +
  `[ "$ic" = 1 ] && args="$args -i"; [ "$ww" = 1 ] && args="$args -w"; [ "$rx" = 1 ] || args="$args -F"; ` +
  `rg $args -e "$q" -- . 2>/dev/null | head -n 500; ` +
  `else ` +
  `args="-rnI"; [ "$ic" = 1 ] && args="\${args}i"; [ "$ww" = 1 ] && args="$args -w"; ` +
  `[ "$rx" = 1 ] && args="$args -E" || args="$args -F"; ` +
  `grep $args -e "$q" . 2>/dev/null | head -n 500; fi`;
export function searchArgv(dir: string, query: string, opts: SearchOptions): string[] {
  return [
    'sh',
    '-c',
    SEARCH_SCRIPT,
    'flock-ws',
    dir,
    query,
    opts.caseSensitive ? '0' : '1',
    opts.wholeWord ? '1' : '0',
    opts.regex ? '1' : '0',
  ];
}

export class NodeWorkspaceService {
  private readonly transports: NodeFsTransportResolver;
  private readonly timeoutMs: number;

  constructor(deps: { transports: NodeFsTransportResolver; timeoutMs?: number }) {
    this.transports = deps.transports;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async transport(nodeId: string): Promise<NodeTransport> {
    const t = await this.transports.transportForNode(nodeId);
    if (!t) throw new NodeUnreachableError(nodeId);
    return t;
  }

  async detectStack(nodeId: string, path: string): Promise<StackInfo> {
    const t = await this.transport(nodeId);
    const r = await t.exec(stackArgv(path), { timeoutMs: this.timeoutMs }).catch((e) => {
      throw new NodePathError(nodeId, e instanceof Error ? e.message : 'stack detect failed');
    });
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const abs = lines.shift() ?? '';
    if (r.exitCode !== 0 || abs === ERR || abs === '') {
      throw new NodePathError(nodeId, `cannot read "${path}".`);
    }
    const gitRepo = lines.includes('__git__');
    const gitHasCommits = lines.includes('__git_commits__');
    const markers = new Set(['__git__', '__git_commits__']);
    return {
      path: abs,
      stacks: [...new Set(lines.filter((l) => !markers.has(l)))],
      gitRepo,
      gitHasCommits,
    };
  }

  async listFiles(nodeId: string, path: string, cap = 5000): Promise<string[]> {
    const t = await this.transport(nodeId);
    const r = await t.exec(filesArgv(path, cap), { timeoutMs: this.timeoutMs }).catch((e) => {
      throw new NodePathError(nodeId, e instanceof Error ? e.message : 'file list failed');
    });
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines[0] === ERR) throw new NodePathError(nodeId, `cannot read "${path}".`);
    return lines;
  }

  async search(
    nodeId: string,
    path: string,
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    if (!query) return { matches: [], truncated: false };
    const t = await this.transport(nodeId);
    const r = await t
      .exec(searchArgv(path, query, opts), { timeoutMs: this.timeoutMs })
      .catch((e) => {
        throw new NodePathError(nodeId, e instanceof Error ? e.message : 'search failed');
      });
    const lines = r.stdout.split('\n');
    if (lines[0]?.trim() === ERR) throw new NodePathError(nodeId, `cannot search "${path}".`);
    const matches: SearchMatch[] = [];
    for (const raw of lines) {
      const m = raw.match(/^(.*?):(\d+):(.*)$/);
      if (!m) continue;
      matches.push({
        file: m[1]!.replace(/^\.\//, ''),
        line: Number(m[2]),
        text: m[3]!.slice(0, 400),
      });
    }
    return { matches, truncated: matches.length >= 500 };
  }
}
