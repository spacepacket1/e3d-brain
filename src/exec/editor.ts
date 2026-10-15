// `ebrain inbox accept --edit` (Phase 8): open the accepted note in the
// owner's editor. The only process spawn so far (I3: child_process lives in
// src/exec/ only). The editor comes from the owner's own environment
// (`$VISUAL`, then `$EDITOR`) and must be a single command: an absolute path
// or a bare program name, no arguments and no shell syntax. It is spawned
// with an argument array, never through a shell; the file is the only
// argument.

import { spawnSync } from 'node:child_process';
import type { SafePath } from '../safe-path.js';

const EDITOR_RE = /^(?:\/[A-Za-z0-9._+\-/]+|[A-Za-z0-9._+-]+)$/;

/** The configured editor command, or an error message. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): { command: string } | { error: string } {
  const raw = (env['VISUAL'] ?? '') !== '' ? env['VISUAL']! : (env['EDITOR'] ?? '');
  if (raw === '') return { error: 'set $VISUAL or $EDITOR to use --edit' };
  if (!EDITOR_RE.test(raw)) return { error: '$VISUAL/$EDITOR must be a single program (absolute path or name) without arguments' };
  return { command: raw };
}

/** Run the editor on `file` attached to this terminal; returns its exit status (or an error message). */
export function openInEditor(file: SafePath, env: NodeJS.ProcessEnv = process.env): { status: number } | { error: string } {
  const cmd = editorCommand(env);
  if ('error' in cmd) return cmd;
  const res = spawnSync(cmd.command, [file], { stdio: 'inherit', shell: false, env });
  if (res.error !== undefined) return { error: `could not start the editor (${(res.error as NodeJS.ErrnoException).code ?? 'error'})` };
  return { status: res.status ?? 1 };
}
