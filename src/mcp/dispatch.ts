// The single path for every MCP tool call, in every mode (Phase 4). Tools
// are registered only through `registerTool`; `dispatch`:
//   1. looks the tool up and checks it is registered for the instance's mode
//      (a tool of another mode is indistinguishable from an unknown one);
//   2. validates the arguments against the tool's schema (unknown keys fail);
//   3. calls the handler with the effective size cap;
//   4. renders the result envelope, fencing every data part (I6) and capping
//      the total size;
//   5. converts a thrown ToolRejection into a structured MCP error, and any
//      other exception into a generic one (never a stack trace);
//   6. reports one DispatchRecord per call through `ctx.onRecord` (the audit
//      line is written from here in Phase 5).
//
// The MCP server (Phase 6) wires its tools/list and tools/call handlers to
// `listTools` and `dispatch` in this module; a scan test fails if any other
// module registers a tool handler with the server.

import type { Mode } from '../config.js';
import { MAX_CHARS_CEILING } from '../config.js';
import { fence, truncateText } from './fence.js';
import { assertToolSchema, validate, type ObjectSchema } from './schema.js';

export const MODES: readonly Mode[] = ['inbox', 'journal', 'read-only'];

/** No tool name in any mode may match this (I2: no accept/promote/edit/delete/move/overwrite, no jobs). */
export const FORBIDDEN_TOOL_NAME = /accept|promote|edit|delete|move|overwrite|run|job|start/;

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DETAIL = 500;

export type RejectionType = 'limit' | 'strict-scrub' | 'invalid';

/** A handler's refusal. `detail` is shown to the caller: never put note text, query text, or secrets in it. */
export class ToolRejection extends Error {
  readonly type: RejectionType;
  readonly detail: string;
  constructor({ type, detail }: { type: RejectionType; detail: string }) {
    super(`${type}: ${detail}`);
    this.name = 'ToolRejection';
    this.type = type;
    this.detail = detail;
  }
}

/** Server-written text, or untrusted note/archive text that dispatch fences. */
export type ContentPart = { type: 'text'; text: string } | { type: 'data'; text: string; source?: string };

export interface ReturnedNote {
  id: string;
  rev: string;
}

/** What a handler returns. */
export interface ToolResult {
  content: string | readonly ContentPart[];
  recall_id?: string;
  returned?: readonly ReturnedNote[];
  count?: number;
}

export interface ToolContext {
  mode: Mode;
  principal: { id: string; type: 'human' | 'agent' };
  /** Effective output cap for this call (config ceiling, lowered by `max_chars`). */
  maxChars: number;
}

export type ToolHandler<A = Record<string, unknown>> = (args: A, ctx: ToolContext) => ToolResult | Promise<ToolResult>;

export interface ToolDefinition<A = Record<string, unknown>> {
  name: string;
  modes: readonly Mode[];
  description?: string;
  schema: ObjectSchema;
  handler: ToolHandler<A>;
}

interface RegisteredTool {
  name: string;
  modes: readonly Mode[];
  description: string;
  schema: ObjectSchema;
  handler: ToolHandler;
}

// Registered tools live in a module-private map per registry, so handlers
// are reachable only through `dispatch`.
const toolsOf = new WeakMap<ToolRegistry, Map<string, RegisteredTool>>();

export class ToolRegistry {
  constructor() {
    toolsOf.set(this, new Map());
  }

  /** Registered names in registration order. */
  names(): string[] {
    return [...toolsOf.get(this)!.keys()];
  }
}

/** The registry the MCP server uses. Tests pass their own. */
export const defaultRegistry = new ToolRegistry();

/** Register a tool. The only way a tool handler reaches the server. */
export function registerTool<A extends Record<string, unknown>>(def: ToolDefinition<A>, registry: ToolRegistry = defaultRegistry): void {
  if (typeof def.name !== 'string' || !TOOL_NAME_RE.test(def.name)) throw new Error('tool name must be lowercase snake_case');
  if (FORBIDDEN_TOOL_NAME.test(def.name)) throw new Error(`tool name "${def.name}" is forbidden in every mode`);
  if (!Array.isArray(def.modes) || def.modes.length === 0) throw new Error(`tool "${def.name}" needs at least one mode`);
  for (const m of def.modes) if (!MODES.includes(m)) throw new Error(`tool "${def.name}" has an unknown mode`);
  if (typeof def.handler !== 'function') throw new Error(`tool "${def.name}" needs a handler`);
  assertToolSchema(def.schema);
  const tools = toolsOf.get(registry)!;
  if (tools.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
  tools.set(def.name, {
    name: def.name,
    modes: [...def.modes],
    description: def.description ?? '',
    schema: def.schema,
    handler: def.handler as ToolHandler,
  });
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
}

/** Tools visible in `mode`, in registration order. */
export function listTools(mode: Mode, registry: ToolRegistry = defaultRegistry): ListedTool[] {
  return [...toolsOf.get(registry)!.values()]
    .filter((t) => t.modes.includes(mode))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: { ...t.schema, additionalProperties: false } }));
}

export type Outcome = 'ok' | 'rejected' | 'invalid' | 'error';

/** One per call; Phase 5 turns it into the audit line. Never contains output text. */
export interface DispatchRecord {
  tool: string;
  mode: Mode;
  principal: string;
  outcome: Outcome;
  /** Validated arguments (absent when validation failed). Phase 5 reduces them to paths, ids, and counts. */
  args?: Readonly<Record<string, unknown>>;
  error?: { type: string; detail: string };
  result_count?: number;
  bytes_returned: number;
  recall_id?: string;
  returned?: readonly ReturnedNote[];
}

export interface DispatchContext {
  mode: Mode;
  principal: { id: string; type: 'human' | 'agent' };
  /** `limits.maxCharsPerCall` from the instance config. */
  maxCharsPerCall: number;
  registry?: ToolRegistry;
  onRecord?: (record: DispatchRecord) => void;
}

/** The MCP `tools/call` result shape. */
export interface ToolCallResponse {
  content: { type: 'text'; text: string }[];
  isError?: true;
  structuredContent?: { error: { type: string; detail: string } };
}

/** Notice appended after the last part that fit when output was cut. */
export function truncationNotice(cap: number): string {
  return `[output truncated to the ${cap}-character cap]`;
}

/**
 * Render content parts into one string of at most `cap` characters. Data
 * parts are fenced (I6); when the whole does not fit, parts are kept in order
 * until the budget runs out (the last may be shortened, a fenced part only
 * with its fence intact), and a truncation notice ends the text.
 */
export function renderContent(content: string | readonly ContentPart[], cap: number): { text: string; truncated: boolean } {
  const parts: readonly ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const render = (p: ContentPart, max?: number): string | undefined => {
    if (p.type === 'text') return max === undefined ? p.text : truncateText(p.text, max);
    const opts = p.source === undefined ? {} : { source: p.source };
    return fence(p.text, max === undefined ? opts : { ...opts, maxChars: max })?.text;
  };
  const full = parts.map((p) => render(p)!).join('\n');
  if (full.length <= cap) return { text: full, truncated: false };

  const notice = truncationNotice(cap);
  let budget = cap - notice.length;
  const out: string[] = [];
  for (const p of parts) {
    const sep = out.length === 0 ? 0 : 1;
    const room = budget - sep - 1; // keep one for the newline before the notice
    if (room <= 0) break;
    const whole = render(p)!;
    if (whole.length <= room) {
      out.push(whole);
      budget -= whole.length + sep;
      continue;
    }
    const cut = render(p, room);
    if (cut !== undefined && cut !== '') out.push(cut);
    break;
  }
  out.push(notice);
  return { text: truncateText(out.join('\n'), cap), truncated: true };
}

function cleanDetail(detail: string): string {
  return truncateText(String(detail).replace(/[\p{Cc}\p{Cf}]/gu, ' '), MAX_DETAIL);
}

function errorResponse(type: string, detail: string): ToolCallResponse {
  const error = { type, detail };
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true, structuredContent: { error } };
}

/** Effective cap: the hard ceiling, lowered by config, lowered again by a valid `max_chars`. */
export function effectiveCap(maxCharsPerCall: number, maxCharsArg: unknown): number {
  let cap = Math.min(MAX_CHARS_CEILING, maxCharsPerCall);
  if (typeof maxCharsArg === 'number' && Number.isSafeInteger(maxCharsArg) && maxCharsArg >= 1) cap = Math.min(cap, maxCharsArg);
  return cap;
}

/** Handle one `tools/call`. Never throws; failures come back as structured MCP errors. */
export async function dispatch(ctx: DispatchContext, name: unknown, rawArgs: unknown): Promise<ToolCallResponse> {
  const registry = ctx.registry ?? defaultRegistry;
  const toolName = typeof name === 'string' ? truncateText(name, 64) : '';
  const base = { tool: toolName, mode: ctx.mode, principal: ctx.principal.id };
  const finish = (record: DispatchRecord, response: ToolCallResponse): ToolCallResponse => {
    ctx.onRecord?.(record);
    return response;
  };
  const fail = (outcome: Outcome, type: string, detail: string, args?: Record<string, unknown>): ToolCallResponse => {
    const response = errorResponse(type, cleanDetail(detail));
    const record: DispatchRecord = { ...base, outcome, error: response.structuredContent!.error, bytes_returned: Buffer.byteLength(response.content[0]!.text) };
    if (args !== undefined) record.args = args;
    return finish(record, response);
  };

  const tool = typeof name === 'string' ? toolsOf.get(registry)!.get(name) : undefined;
  if (tool === undefined || !tool.modes.includes(ctx.mode)) return fail('invalid', 'invalid', 'unknown tool');

  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  const problem = validate(tool.schema, args);
  if (problem !== undefined) return fail('invalid', 'invalid', problem);
  const valid = args as Record<string, unknown>;

  const maxChars = effectiveCap(ctx.maxCharsPerCall, valid['max_chars']);
  let result: ToolResult;
  try {
    result = await tool.handler(valid, { mode: ctx.mode, principal: { ...ctx.principal }, maxChars });
  } catch (err) {
    if (err instanceof ToolRejection) {
      return fail(err.type === 'invalid' ? 'invalid' : 'rejected', err.type, err.detail, valid);
    }
    return fail('error', 'internal', 'internal error', valid);
  }

  let text: string;
  try {
    text = renderContent(result.content, maxChars).text;
  } catch {
    return fail('error', 'internal', 'internal error', valid);
  }
  const response: ToolCallResponse = { content: [{ type: 'text', text }] };
  const record: DispatchRecord = { ...base, outcome: 'ok', args: valid, bytes_returned: Buffer.byteLength(text) };
  const count = result.count ?? result.returned?.length;
  if (count !== undefined) record.result_count = count;
  if (result.recall_id !== undefined) record.recall_id = result.recall_id;
  if (result.returned !== undefined) record.returned = result.returned.map((r) => ({ id: r.id, rev: r.rev }));
  return finish(record, response);
}
