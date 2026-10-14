// `ebrain refs add <file.pdf>` (Phase 11): PDF text through the optional
// external `pdftotext` binary (poppler). There is no PDF parsing library. The
// binary is spawned by its fixed name (looked up on PATH by the OS, never
// through a shell) with an argument array, a timeout, and an output size cap.
// If it is not installed, PDFs are refused with a clear message.

import { spawnSync } from 'node:child_process';
import type { SafePath } from '../safe-path.js';

export const PDFTOTEXT = 'pdftotext';
export const PDFTOTEXT_TIMEOUT_MS = 60_000;
export const PDFTOTEXT_MAX_BYTES = 64 * 1024 * 1024;

export type PdfResult =
  | { ok: true; text: Buffer }
  | { ok: false; reason: 'absent' | 'timeout' | 'too-large' | 'failed'; message: string };

export interface PdfOptions {
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run `pdftotext -enc UTF-8 -q <file> -` and return its stdout. `file` is a validated absolute path. */
export function pdfToText(file: SafePath, opts: PdfOptions = {}): PdfResult {
  const env = opts.env ?? process.env;
  const maxBytes = opts.maxBytes ?? PDFTOTEXT_MAX_BYTES;
  const res = spawnSync(PDFTOTEXT, ['-enc', 'UTF-8', '-q', file, '-'], {
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: opts.timeoutMs ?? PDFTOTEXT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: maxBytes,
    env: { PATH: env['PATH'] ?? '' },
  });
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { ok: false, reason: 'absent', message: 'PDF support needs the external `pdftotext` binary (poppler-utils), which was not found on PATH' };
  }
  if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout', message: `pdftotext did not finish within ${opts.timeoutMs ?? PDFTOTEXT_TIMEOUT_MS} ms` };
  if (code === 'ENOBUFS') return { ok: false, reason: 'too-large', message: `pdftotext output exceeds ${maxBytes} bytes` };
  if (res.error !== undefined) return { ok: false, reason: 'failed', message: `pdftotext could not run (${code ?? 'error'})` };
  if (res.status !== 0) return { ok: false, reason: 'failed', message: `pdftotext exited with status ${res.status ?? res.signal ?? 'unknown'}` };
  return { ok: true, text: res.stdout };
}
