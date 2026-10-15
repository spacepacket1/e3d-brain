// `ebrain eval replay` (cognition Phase 9): read-only git queries on the
// vault's repository. `git` is spawned by its fixed name with an argument
// array (never a shell string), a timeout, and an output cap. Only read
// commands are used (`rev-parse`, `rev-list`, `log`, `status`, `archive`);
// never `worktree`, `checkout`, or anything else that changes the owner's
// repository or working tree. `status` runs with `core.fsmonitor` off so no
// configured helper program is started.

import { spawnSync } from 'node:child_process';

export const GIT = 'git';
export const GIT_TIMEOUT_MS = 120_000;
/** Largest `git archive` output read (the whole vault at one commit, as a tar stream). */
export const GIT_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const SMALL_OUTPUT = 1024 * 1024;
/** Commit-ish arguments: a ref name, hash, or `HEAD~2`-style expression; never an option. */
const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,199}$/;

export class GitError extends Error {
  constructor(message: string, readonly reason: 'absent' | 'not-repo' | 'failed') {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function run(dir: string, args: readonly string[], opts: GitOptions & { maxBytes?: number } = {}): Buffer {
  const env = opts.env ?? process.env;
  const res = spawnSync(GIT, ['-C', dir, ...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: opts.maxBytes ?? SMALL_OUTPUT,
    env: {
      PATH: env['PATH'] ?? '', HOME: env['HOME'] ?? '', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    },
  });
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') throw new GitError('git was not found on PATH', 'absent');
  if (code === 'ETIMEDOUT') throw new GitError(`git ${args[0]} did not finish in time`, 'failed');
  if (code === 'ENOBUFS') throw new GitError(`git ${args[0]} output is too large`, 'failed');
  if (res.error !== undefined) throw new GitError(`git could not run (${code ?? 'error'})`, 'failed');
  if (res.status !== 0) {
    const err = res.stderr.toString('utf8');
    if (/not a git repository/i.test(err)) throw new GitError('the vault is not in a git repository', 'not-repo');
    throw new GitError(`git ${args[0]} failed: ${err.split('\n')[0]?.slice(0, 200) ?? ''}`.trimEnd(), 'failed');
  }
  return res.stdout;
}

const text = (b: Buffer): string => b.toString('utf8').trim();

export interface RepoInfo {
  /** The vault's path relative to the repository root, without a trailing slash ('' at the root). */
  prefix: string;
  shallow: boolean;
  /** True when the repository has at least one commit. */
  hasHead: boolean;
}

/** Where `dir` sits in its repository. Throws GitError('not-repo') outside one. */
export function repoInfo(dir: string, opts: GitOptions = {}): RepoInfo {
  const out = text(run(dir, ['rev-parse', '--show-prefix', '--is-shallow-repository'], opts)).split('\n');
  const shallowLine = out.pop() ?? 'false';
  const prefix = (out[0] ?? '').replace(/\/+$/, '');
  let hasHead = true;
  try {
    run(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], opts);
  } catch (err) {
    if (!(err instanceof GitError) || err.reason !== 'failed') throw err;
    hasHead = false;
  }
  return { prefix, shallow: shallowLine.trim() === 'true', hasHead };
}

/** Resolve a commit-ish to a full commit hash, or undefined. */
export function resolveCommit(dir: string, rev: string, opts: GitOptions = {}): string | undefined {
  if (!REV_RE.test(rev)) return undefined;
  try {
    const out = text(run(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], opts));
    return /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
  } catch (err) {
    if (err instanceof GitError && err.reason === 'failed') return undefined;
    throw err;
  }
}

/** The newest commit on HEAD's history committed at or before `isoDate`, or undefined. */
export function commitAtDate(dir: string, isoDate: string, opts: GitOptions = {}): string | undefined {
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return undefined;
  const out = text(run(dir, ['rev-list', '-1', `--before=${Math.floor(t / 1000)}`, 'HEAD'], opts));
  return /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
}

/** The committer date of `commit` (ISO 8601). */
export function commitTime(dir: string, commit: string, opts: GitOptions = {}): string {
  return text(run(dir, ['log', '-1', '--format=%cI', '--end-of-options', commit], opts));
}

/** Tracked files under `dir` with uncommitted changes (untracked files are ignored). */
export function dirtyPaths(dir: string, opts: GitOptions = {}): string[] {
  const out = run(dir, ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '-z', '--untracked-files=no', '--', '.'], opts).toString('utf8');
  return out.split('\0').filter((x) => x !== '').map((x) => x.slice(3));
}

/** `git archive --format=tar <commit>[:<prefix>]`: the tree at `commit` (only `prefix`, re-rooted) as a tar stream. */
export function archiveTree(dir: string, commit: string, prefix: string, opts: GitOptions & { maxBytes?: number } = {}): Buffer {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError('archive needs a full commit hash', 'failed');
  return run(dir, ['archive', '--format=tar', '--end-of-options', prefix === '' ? commit : `${commit}:${prefix}`], { ...opts, maxBytes: opts.maxBytes ?? GIT_ARCHIVE_MAX_BYTES });
}
