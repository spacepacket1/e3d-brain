// Secret and sensitive-data scrubber (Phase 7, I5). A pure library: no I/O.
//
//   scrub(text, opts) -> { ok: true, text, findings } on success, or
//                        { ok: false, findings, rejection } in strict mode
//
// Every detected span is replaced by `[REDACTED:<type>]`. Findings are
// `{type, count}` only and never contain the matched text. Scrubbing repeats
// until a pass finds nothing, so `scrub(scrub(x).text).text === scrub(x).text`.
//
// Strict mode (an agent principal, or `strict: true`): any credential-class
// detection (see CREDENTIAL_TYPES) rejects the whole write; the rejection
// names detector types only and carries no text. PII-class detections and the
// entropy heuristic still redact and continue.
//
// Writers must use `scrubForWrite` (or check `ok`) and abort the write on any
// exception: never persist unscrubbed text.

import type { PrincipalType } from '../config.js';
import {
  CREDENTIAL_TYPES,
  DEFAULT_ENTROPY_THRESHOLD,
  DEFAULT_HEX_ENTROPY_THRESHOLD,
  DETECTOR_TYPES,
  detect,
  isCredentialType,
  type DetectorType,
} from './detectors.js';

export { CREDENTIAL_TYPES, DEFAULT_ENTROPY_THRESHOLD, DEFAULT_HEX_ENTROPY_THRESHOLD, DETECTOR_TYPES, isCredentialType, type DetectorType };

/**
 * Stamped into the frontmatter of every note a writer persists (Phases 8-13).
 * Bump it whenever a detector change could redact text the previous version
 * kept.
 */
export const scrubVersion = 1;

/** Limits on `scrub.extraPatterns` (user literal strings; arbitrary regexes are out of scope). */
export const MAX_EXTRA_PATTERNS = 64;
export const MIN_EXTRA_PATTERN_LENGTH = 4;
export const MAX_EXTRA_PATTERN_LENGTH = 256;
/** Passes before giving up (each pass only removes text; in practice two passes suffice). */
const MAX_PASSES = 8;

export interface ScrubOptions {
  /** The writing principal; `type: 'agent'` turns on strict mode. */
  principal?: { type: PrincipalType };
  /** Force strict mode regardless of principal. */
  strict?: boolean;
  /** User literal strings (case-sensitive) to redact as `extra-pattern`. */
  extraPatterns?: readonly string[];
  /** Entropy threshold in bits/char for base64-like strings (default DEFAULT_ENTROPY_THRESHOLD). */
  entropyThreshold?: number;
  /** Entropy threshold in bits/char for pure-hex strings (default DEFAULT_HEX_ENTROPY_THRESHOLD). */
  hexEntropyThreshold?: number;
}

export interface ScrubFinding {
  type: DetectorType;
  count: number;
}

export interface ScrubRejection {
  type: 'strict-scrub';
  /** Credential-class detector types that triggered the rejection, in priority order. */
  detectors: DetectorType[];
}

export type ScrubResult =
  | { ok: true; text: string; findings: ScrubFinding[] }
  | { ok: false; findings: ScrubFinding[]; rejection: ScrubRejection };

/** Scrubbing failed (bad options or an internal error). The write must be aborted. */
export class ScrubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrubError';
  }
}

export function redactionToken(type: DetectorType): string {
  return `[REDACTED:${type}]`;
}

/** Validate user literals; the message never echoes a literal. */
export function checkExtraPatterns(patterns: unknown): string | undefined {
  if (!Array.isArray(patterns)) return 'must be an array of strings';
  if (patterns.length > MAX_EXTRA_PATTERNS) return `must have at most ${MAX_EXTRA_PATTERNS} entries`;
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length < MIN_EXTRA_PATTERN_LENGTH || p.length > MAX_EXTRA_PATTERN_LENGTH) {
      return `entries must be strings of ${MIN_EXTRA_PATTERN_LENGTH}-${MAX_EXTRA_PATTERN_LENGTH} characters`;
    }
    if (/[\0\n\r]/.test(p)) return 'entries must not contain NUL or line breaks';
  }
  return undefined;
}

function threshold(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new ScrubError(`${name} must be a number above 0 and at most ${max}`);
  }
  return value;
}

function isStrict(opts: ScrubOptions): boolean {
  return opts.strict === true || opts.principal?.type === 'agent';
}

function scrubUnsafe(text: string, opts: ScrubOptions): ScrubResult {
  if (typeof text !== 'string') throw new ScrubError('scrub input must be a string');
  const extraPatterns = opts.extraPatterns ?? [];
  const bad = checkExtraPatterns(extraPatterns);
  if (bad !== undefined) throw new ScrubError(`scrub.extraPatterns ${bad}`);
  const detectOpts = {
    extraPatterns,
    entropyThreshold: threshold(opts.entropyThreshold, DEFAULT_ENTROPY_THRESHOLD, 8, 'entropyThreshold'),
    hexEntropyThreshold: threshold(opts.hexEntropyThreshold, DEFAULT_HEX_ENTROPY_THRESHOLD, 4, 'hexEntropyThreshold'),
  };

  const counts = new Map<DetectorType, number>();
  let current = text;
  let settled = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const spans = detect(current, detectOpts);
    if (spans.length === 0) {
      settled = true;
      break;
    }
    let out = '';
    let pos = 0;
    for (const s of spans) {
      out += current.slice(pos, s.start) + redactionToken(s.type);
      pos = s.end;
      counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
    }
    current = out + current.slice(pos);
  }
  if (!settled) throw new ScrubError('scrubbing did not settle');

  const findings = DETECTOR_TYPES.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));
  if (isStrict(opts)) {
    const detectors = findings.map((f) => f.type).filter(isCredentialType);
    if (detectors.length > 0) return { ok: false, findings, rejection: { type: 'strict-scrub', detectors } };
  }
  return { ok: true, text: current, findings };
}

/**
 * Scrub `text`. Throws ScrubError if the options are invalid or scrubbing
 * fails; the error message never contains input text.
 */
export function scrub(text: string, opts: ScrubOptions = {}): ScrubResult {
  try {
    return scrubUnsafe(text, opts);
  } catch (err) {
    if (err instanceof ScrubError) throw err;
    throw new ScrubError(`scrubbing failed (${err instanceof Error ? err.name : 'unknown error'})`);
  }
}

/** Thrown by `scrubForWrite` when strict mode rejects the text. */
export class ScrubRejectedError extends Error {
  readonly rejection: ScrubRejection;
  readonly findings: ScrubFinding[];
  constructor(rejection: ScrubRejection, findings: ScrubFinding[]) {
    super(`write rejected: credential detected (${rejection.detectors.join(', ')})`);
    this.name = 'ScrubRejectedError';
    this.rejection = rejection;
    this.findings = findings;
  }
}

export interface ScrubbedWrite {
  text: string;
  findings: ScrubFinding[];
  scrubVersion: number;
}

/**
 * The writer entry point: returns scrubbed text plus the version to stamp in
 * frontmatter, or throws (ScrubRejectedError in strict mode, ScrubError on
 * failure). Callers persist only the returned text and abort on any throw.
 */
export function scrubForWrite(text: string, opts: ScrubOptions = {}): ScrubbedWrite {
  const r = scrub(text, opts);
  if (!r.ok) throw new ScrubRejectedError(r.rejection, r.findings);
  return { text: r.text, findings: r.findings, scrubVersion };
}

/** One line per finding type, `type: count`, for CLI and logs. Never contains matched text. */
export function formatFindings(findings: readonly ScrubFinding[]): string {
  return findings.map((f) => `${f.type}: ${f.count}`).join('\n');
}
