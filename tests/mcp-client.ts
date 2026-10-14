// A minimal MCP client for the Phase 6 integration tests: spawns `ebrain mcp`
// and speaks newline-delimited JSON-RPC 2.0 over its stdio, keeping every raw
// stdout line so tests can assert that stdout carried protocol frames only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { repoRoot } from './helpers.js';

export interface ToolResponse {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: { error: { type: string; detail: string } };
}

export class McpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every stdout line, verbatim. */
  readonly stdoutLines: string[] = [];
  stderr = '';
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly exited: Promise<number | null>;

  constructor(configPath: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js'), 'mcp'], {
      env: { PATH: process.env.PATH ?? '', HOME: path.dirname(configPath), EBRAIN_CONFIG: configPath, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`server exited (${code}); stderr: ${this.stderr}`));
      this.pending.clear();
      resolve(code);
    }));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.stdoutLines.push(line);
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`rpc error: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  }

  /** Bytes received on stdout that did not end with a newline yet. */
  get partialStdout(): string {
    return this.buffer;
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<{ serverInfo: { name: string } }> {
    const result = await this.request<{ serverInfo: { name: string } }>('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ebrain-test', version: '0' },
    });
    this.notify('notifications/initialized');
    return result;
  }

  async listTools(): Promise<string[]> {
    const r = await this.request<{ tools: { name: string }[] }>('tools/list');
    return r.tools.map((t) => t.name);
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
    return this.request<ToolResponse>('tools/call', { name, arguments: args });
  }

  /** Close stdin and wait for the server to exit. */
  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

/** The JSON header (first line) of a tool response. */
export function header(r: ToolResponse): Record<string, unknown> & { recall_id: string; count: number } {
  return JSON.parse(r.content[0]!.text.split('\n')[0]!) as Record<string, unknown> & { recall_id: string; count: number };
}

export interface FencedBlock {
  fence: string;
  label: string;
  body: string[];
  /** Lines after the closing fence. */
  after: string[];
}

/** Parse the one fenced data block of a response: label line, opening fence, body, closing fence. */
export function fencedBlock(text: string): FencedBlock | undefined {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
  if (open < 0) return undefined;
  const fence = lines[open]!.slice(0, -'text'.length);
  // The block closes at the first line that is a backtick run at least as long as the fence (CommonMark).
  const close = lines.findIndex((l, i) => i > open && /^`+\s*$/.test(l) && l.trim().length >= fence.length);
  if (close < 0) throw new Error('unterminated fence');
  return { fence, label: lines[open - 1] ?? '', body: lines.slice(open + 1, close), after: lines.slice(close + 1) };
}

/** Results of a list response (JSON Lines inside the fence). */
export function results(r: ToolResponse): Record<string, unknown>[] {
  const block = fencedBlock(r.content[0]!.text);
  return block === undefined ? [] : block.body.map((l) => JSON.parse(l) as Record<string, unknown>);
}
