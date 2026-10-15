// Phase 14: the shared LLM layer (src/llm/) and `ebrain propose`. A loopback
// mock answers OpenAI-compatible and Anthropic requests. Covered: config
// rules (provider, allowlist, key by env-var name only), provider `none`
// (message, no network), mode/principal refusals, schema-valid candidates in
// `_inbox/` citing archive turn ranges, malformed output dropped and counted,
// the anthropic gate (allowlist + flag), no raw secrets in request bodies,
// idempotency, nothing outside `_inbox/` changing, budgets, filters, and a
// scan keeping provider code out of src/propose/.

import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseCitation } from '../src/cite/citation.js';
import { runConversationImport } from '../src/cli/import-commands.js';
import { runPropose } from '../src/cli/propose-command.js';
import { ConfigError, parseConfig } from '../src/config.js';
import { RAW_CONVERSATIONS_DIR } from '../src/import/archive.js';
import { RunBudget } from '../src/llm/budget.js';
import { currentPrompt, promptHash, promptId } from '../src/llm/prompts/index.js';
import { createProvider, LlmRefusedError } from '../src/llm/provider.js';
import { matchesSchema, parseJsonOutput, validateOutput } from '../src/llm/schema.js';
import { parseTurns } from '../src/propose/archive-reader.js';
import { candidateId, CANDIDATE_ID_RE, CANDIDATE_KINDS, LEDGER_FILE } from '../src/propose/propose.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, repoRoot, rmrf } from './helpers.js';
import { startLlmMock, type LlmMock } from './llm-mock-server.js';
import { fake } from './scrub-fixtures.js';

const bases: string[] = [];
let llm: LlmMock;
before(async () => {
  llm = await startLlmMock();
});
after(async () => {
  for (const b of bases) rmrf(b);
  await llm.close();
});
afterEach(() => {
  mock.restoreAll();
  llm.mode = 'normal';
});

const NOW = new Date('2026-10-14T12:00:00Z');
const SESSION_NEW = '1a2b3c4d-0000-4000-8000-000000000001';
const SESSION_OLD = '1a2b3c4d-0000-4000-8000-000000000002';

interface Env {
  base: string;
  vault: string;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  secrets: string[];
}

function writeConfig(e: Env, patch: Record<string, unknown>): void {
  const body = { vaultPath: e.vault, stateDir: e.stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox', ...patch };
  fs.writeFileSync(e.configPath, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(e.configPath, 0o600);
}

function openaiCfg(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { llm: { provider: 'openai-compatible', model: 'mock-1', baseUrl: `${llm.url}/v1`, ...extra } };
}

/** A vault with two archived Claude Code sessions (one with fake secrets) and one curated note. */
async function makeEnv(): Promise<Env> {
  const base = realTmpDir('ebrain-p14-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'notes', 'keep.md'), '# Keep\n\nCurated.\n');
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const e: Env = { base, vault, stateDir, configPath: path.join(base, 'config.json'), env: {}, secrets: [] };
  e.env = { EBRAIN_CONFIG: e.configPath };
  writeConfig(e, {});
  const key = fake.openai();
  const aws = fake.awsId();
  e.secrets.push(key, aws);
  const proj = path.join(base, 'projects', '-home-u-proj');
  fs.mkdirSync(proj, { recursive: true });
  const rec = (session: string, type: 'user' | 'assistant', at: string, text: string) =>
    JSON.stringify({
      type, sessionId: session, timestamp: at,
      message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', id: `m-${at}`, content: [{ type: 'text', text }] },
    });
  fs.writeFileSync(
    path.join(proj, `${SESSION_NEW}.jsonl`),
    [
      rec(SESSION_NEW, 'user', '2026-10-01T10:00:00Z', `Let's pick a database. My key is ${key} by the way.`),
      rec(SESSION_NEW, 'assistant', '2026-10-01T10:01:00Z', 'Postgres fits your workload well.'),
      rec(SESSION_NEW, 'user', '2026-10-01T10:02:00Z', `We decided to use Postgres for billing.\nI prefer small pull requests over big ones. aws ${aws}`),
      rec(SESSION_NEW, 'assistant', '2026-10-01T10:03:00Z', 'Noted. One lesson from last time: always run migrations in a transaction.'),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(proj, `${SESSION_OLD}.jsonl`),
    [
      rec(SESSION_OLD, 'user', '2026-01-05T09:00:00Z', 'One idea: a weekly digest of inbox notes.'),
      rec(SESSION_OLD, 'assistant', '2026-01-05T09:01:00Z', 'That could work.'),
    ].join('\n') + '\n',
  );
  const r = await runConversationImport(['claude-code', '--projects-dir', path.join(base, 'projects')], { env: e.env, now: () => NOW });
  assert.equal(r.code, 0, r.stderr);
  return e;
}

function walk(dir: string, rel = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const r = rel === '' ? d.name : `${rel}/${d.name}`;
    return d.isDirectory() ? walk(path.join(dir, d.name), r) : [r];
  }).sort();
}

/** Checksum of every vault file except under `_inbox/`. */
function checksumOutsideInbox(vault: string): string {
  return walk(vault).filter((f) => !f.startsWith('_inbox/')).map((f) => `${f}\0${fs.readFileSync(path.join(vault, f), 'utf8')}`).join('\n');
}

function inboxFiles(vault: string): string[] {
  return walk(path.join(vault, '_inbox')).map((f) => `_inbox/${f}`);
}

function fm(file: string): Record<string, unknown> {
  return parseYaml(splitFrontmatter(fs.readFileSync(file, 'utf8')).yaml!, { schema: 'core' }) as Record<string, unknown>;
}

const run = (e: Env, args: string[] = [], env: NodeJS.ProcessEnv = {}) => runPropose(args, { env: { ...e.env, ...env }, now: () => NOW });

describe('llm config', () => {
  const baseCfg = { vaultPath: '/v/vault', stateDir: '/v/state', principal: { id: 'a', type: 'human' }, mode: 'inbox' };
  it('defaults to provider none with loopback URL and budgets', () => {
    const c = parseConfig(baseCfg);
    assert.equal(c.llm.provider, 'none');
    assert.equal(c.llm.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(c.llm.apiKeyEnv, '');
    assert.ok(c.llm.maxCallsPerRun > 0 && c.llm.maxInputCharsPerRun > 0);
  });
  it('rejects bad llm settings fail-closed', () => {
    const bad: Record<string, unknown>[] = [
      { provider: 'openai' },
      { provider: 'openai-compatible' }, // no model
      { provider: 'openai-compatible', model: 'm', baseUrl: 'https://llm.example.com/v1' }, // not allowlisted
      { provider: 'anthropic', model: 'm' }, // api.anthropic.com not allowlisted
      { apiKey: 'sk-something' }, // keys never live in the config
      { apiKeyEnv: 'sk-live-abc' },
      { maxCallsPerRun: 0 },
      { maxInputCharsPerRun: 'lots' },
    ];
    for (const llmCfg of bad) assert.throws(() => parseConfig({ ...baseCfg, llm: llmCfg }), ConfigError, JSON.stringify(llmCfg));
  });
  it('anthropic: allowlisted host, default key variable', () => {
    const c = parseConfig({ ...baseCfg, network: { allowedHosts: ['api.anthropic.com'] }, llm: { provider: 'anthropic', model: 'claude-x' } });
    assert.equal(c.llm.baseUrl, 'https://api.anthropic.com');
    assert.equal(c.llm.apiKeyEnv, 'ANTHROPIC_API_KEY');
  });
});

describe('llm layer units', () => {
  it('strict schema validation drops and counts, never throws', () => {
    const schema = { a: { type: 'string', min: 1, max: 5 }, n: { type: 'int', min: 1, max: 3 } } as const;
    assert.ok(matchesSchema({ a: 'x', n: 2 }, schema));
    assert.ok(!matchesSchema({ a: 'x', n: 2, extra: 1 }, schema));
    assert.ok(!matchesSchema({ a: 'x' }, schema));
    assert.ok(!matchesSchema({ a: '   ', n: 2 }, schema));
    assert.ok(!matchesSchema({ a: 'x', n: 4 }, schema));
    assert.ok(!matchesSchema({ a: 'x', n: 1.5 }, schema));
    const v = validateOutput('```json\n{"items":[{"a":"x","n":1},{"a":"toolong","n":1},7,{"a":"y","n":2}]}\n```', 'items', schema, 1);
    assert.deepEqual(v, { parsed: true, items: [{ a: 'x', n: 1 }], invalid: 3 });
    for (const t of ['not json', '[]', '{"items":{}}', '{"items":[],"x":1}', 'prefix {"items":[]}']) {
      assert.deepEqual(validateOutput(t, 'items', schema, 10), { parsed: false, items: [], invalid: 0 }, t);
    }
    assert.equal(parseJsonOutput('{"a":1}') !== undefined, true);
  });

  it('budget stops on calls and on input characters', () => {
    const b = new RunBudget(2, 100);
    assert.equal(b.check(60), undefined);
    b.record(60);
    assert.equal(b.check(50), 'max-input-chars');
    assert.equal(b.check(40), undefined);
    b.record(40);
    assert.equal(b.check(0), 'max-calls');
  });

  it('prompts are versioned and hashed', () => {
    const p = currentPrompt('propose');
    assert.equal(promptId(p), 'propose.v1');
    assert.match(promptHash(p), /^[0-9a-f]{16}$/);
    assert.match(p.system, /explicitly stated/);
    assert.match(p.system, /or invent/);
    assert.match(p.instructions, /quote/i);
  });

  it('provider factory: none touches nothing; anthropic needs the allowlist, the flag, and the key variable', () => {
    const cfg = parseConfig({ vaultPath: '/v/vault', stateDir: '/v/state', principal: { id: 'a', type: 'human' }, mode: 'inbox' }).llm;
    assert.equal(createProvider(cfg, { allowedHosts: [] }), undefined);
    const anth = { ...cfg, provider: 'anthropic' as const, model: 'm', baseUrl: llm.url, apiKeyEnv: 'TEST_ANTHROPIC_KEY' };
    assert.throws(() => createProvider(anth, { allowedHosts: [], dataLeavesMachine: true, env: { TEST_ANTHROPIC_KEY: 'k' } }), LlmRefusedError);
    assert.throws(() => createProvider(anth, { allowedHosts: ['api.anthropic.com'], env: { TEST_ANTHROPIC_KEY: 'k' } }), /i-understand-data-leaves-machine/);
    assert.throws(() => createProvider(anth, { allowedHosts: ['api.anthropic.com'], dataLeavesMachine: true, env: {} }), /TEST_ANTHROPIC_KEY/);
    assert.ok(createProvider(anth, { allowedHosts: ['api.anthropic.com'], dataLeavesMachine: true, env: { TEST_ANTHROPIC_KEY: 'k' } }));
  });

  it('archive turns: a "## Turn" line inside a turn does not shift numbering', () => {
    const body = '# T\n\n## Turn 1: User\n\nhello\n## Turn 5: Assistant\nfake\n\n## Turn 2: Assistant (2026-01-01T00:00:00Z)\n\nhi\n';
    assert.deepEqual(parseTurns(body), [
      { n: 1, role: 'user', text: 'hello\n## Turn 5: Assistant\nfake' },
      { n: 2, role: 'assistant', text: 'hi' },
    ]);
  });

  it('candidate ids are stable and depend on archive, range, and statement', () => {
    const a = candidateId('raw_x', 1, 2, 'We  decided\nthis');
    assert.match(a, CANDIDATE_ID_RE);
    assert.equal(a, candidateId('raw_x', 1, 2, 'we decided this'));
    assert.notEqual(a, candidateId('raw_x', 1, 3, 'we decided this'));
    assert.notEqual(a, candidateId('raw_y', 1, 2, 'we decided this'));
  });
});

describe('ebrain propose', () => {
  it('provider none: explains, exits 1, no network, nothing written', async () => {
    const e = await makeEnv();
    const fetchSpy = mock.method(globalThis, 'fetch', async () => {
      throw new Error('network used');
    });
    const before = checksumOutsideInbox(e.vault);
    const r = await run(e);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no extraction provider is configured/);
    assert.equal(fetchSpy.mock.callCount(), 0);
    assert.deepEqual(inboxFiles(e.vault), []);
    assert.equal(checksumOutsideInbox(e.vault), before);
  });

  it('refuses unless mode inbox and a human principal', async () => {
    const e = await makeEnv();
    const n = llm.requests.length;
    for (const patch of [
      { mode: 'read-only', ...openaiCfg() },
      { principal: { id: 'bot', type: 'agent' }, ...openaiCfg() },
      { principal: { id: 'bot', type: 'agent' }, mode: 'journal', ...openaiCfg() },
    ]) {
      writeConfig(e, patch);
      const r = await run(e);
      assert.equal(r.code, 1, JSON.stringify(patch));
      assert.match(r.stderr, /needs mode "inbox" and a human principal/);
    }
    assert.equal(llm.requests.length, n);
    assert.deepEqual(inboxFiles(e.vault), []);
  });

  it('openai-compatible: schema-valid candidates citing turn ranges; malformed items dropped and counted; idempotent; nothing outside _inbox/ changes', async () => {
    const e = await makeEnv();
    // The owner edited an archive file and pasted a raw secret: propose re-scrubs before sending.
    const archive = walk(path.join(e.vault, RAW_CONVERSATIONS_DIR)).map((f) => path.join(e.vault, RAW_CONVERSATIONS_DIR, f));
    const target = archive.find((f) => fs.readFileSync(f, 'utf8').includes('weekly digest'))!;
    const pasted = fake.github('ghp');
    e.secrets.push(pasted);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('That could work.', `That could work. token ${pasted}`));
    writeConfig(e, openaiCfg());
    const before = checksumOutsideInbox(e.vault);
    const n = llm.requests.length;

    const r = await run(e);
    assert.equal(r.code, 0, r.stderr);
    const sent = llm.requests.slice(n);
    assert.equal(sent.length, 2);
    for (const q of sent) {
      assert.equal(q.path, '/v1/chat/completions');
      for (const s of e.secrets) assert.ok(!q.body.includes(s), 'raw secret sent to the provider');
      assert.equal(q.headers['authorization'], undefined);
    }
    assert.ok(sent.some((q) => q.body.includes('[REDACTED:')));
    assert.match(r.stdout, /4 candidates created, 0 duplicates skipped/);
    assert.match(r.stdout, /dropped: 2 invalid items, 2 unsupported quotes, 0 malformed responses/);

    const files = inboxFiles(e.vault);
    assert.equal(files.length, 4);
    const kinds = new Set<string>();
    for (const f of files) {
      const text = fs.readFileSync(path.join(e.vault, f), 'utf8');
      const m = fm(path.join(e.vault, f));
      assert.equal(m['status'], 'proposed');
      assert.equal(m['confidence'], 'unrated');
      assert.equal(m['origin'], 'cli');
      assert.equal(m['author'], 'ebrain-propose');
      assert.equal(m['schema'], 1);
      assert.equal(m['extraction_prompt'], 'propose.v1');
      assert.match(String(m['candidate_id']), CANDIDATE_ID_RE);
      assert.ok((CANDIDATE_KINDS as readonly string[]).includes(String(m['kind'])));
      kinds.add(String(m['kind']));
      const sources = m['sources'] as string[];
      assert.equal(sources.length, 1);
      const c = parseCitation(sources[0]);
      assert.ok(c.ok && c.citation.kind === 'note' && c.citation.turns !== undefined, sources[0]);
      const archiveFile = archive.find((a) => path.basename(a, '.md') === (c.citation as { id: string }).id);
      assert.ok(archiveFile, 'citation names an archive note');
      for (const s of e.secrets) assert.ok(!text.includes(s));
      assert.match(text, /Supporting quote \(turns? \d/);
    }
    assert.deepEqual([...kinds].sort(), ['decision', 'idea', 'lesson', 'preference']);
    assert.equal(checksumOutsideInbox(e.vault), before);

    // Running twice: no duplicates.
    const inboxSum = files.map((f) => fs.readFileSync(path.join(e.vault, f), 'utf8')).join('\n');
    const again = await run(e);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /0 candidates created, 4 duplicates skipped/);
    assert.deepEqual(inboxFiles(e.vault), files);
    assert.equal(files.map((f) => fs.readFileSync(path.join(e.vault, f), 'utf8')).join('\n'), inboxSum);
    assert.equal(checksumOutsideInbox(e.vault), before);

    // An accepted (moved) candidate is not proposed again (ledger).
    fs.renameSync(path.join(e.vault, files[0]!), path.join(e.vault, 'notes', 'accepted.md'));
    const third = await run(e);
    assert.match(third.stdout, /0 candidates created, 4 duplicates skipped/);
    assert.equal(fs.readFileSync(path.join(e.stateDir, LEDGER_FILE), 'utf8').trim().split('\n').length, 4);
  });

  it('a garbage (non-JSON) response is counted, not fatal', async () => {
    const e = await makeEnv();
    writeConfig(e, openaiCfg());
    llm.mode = 'garbage';
    const r = await run(e);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /0 candidates created/);
    assert.match(r.stdout, /2 malformed responses/);
    assert.deepEqual(inboxFiles(e.vault), []);
  });

  it('a provider HTTP error stops the run with exit 1 and writes nothing outside _inbox/', async () => {
    const e = await makeEnv();
    writeConfig(e, openaiCfg());
    llm.mode = 'error';
    const before = checksumOutsideInbox(e.vault);
    const r = await run(e);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 500/);
    assert.ok(!r.stderr.includes('boom'));
    assert.equal(checksumOutsideInbox(e.vault), before);
  });

  it('budget: maxCallsPerRun stops cleanly', async () => {
    const e = await makeEnv();
    writeConfig(e, openaiCfg({ maxCallsPerRun: 1 }));
    const n = llm.requests.length;
    const r = await run(e);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(llm.requests.length - n, 1);
    assert.match(r.stdout, /stopped: budget max-calls reached \(1 windows not sent\)/);
  });

  it('--since and --source filter the archive', async () => {
    const e = await makeEnv();
    writeConfig(e, openaiCfg());
    let n = llm.requests.length;
    const r1 = await run(e, ['--since', '2026-06-01']);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(llm.requests.length - n, 1);
    assert.match(r1.stdout, /1 archive notes/);
    assert.match(r1.stdout, /1 outside the filter/);
    assert.ok(!llm.requests[llm.requests.length - 1]!.body.includes('weekly digest'));

    n = llm.requests.length;
    const r2 = await run(e, ['--source', 'chatgpt-export']);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(llm.requests.length - n, 0);
    assert.match(r2.stdout, /0 archive notes/);

    const old = walk(path.join(e.vault, RAW_CONVERSATIONS_DIR)).map((f) => path.join(e.vault, RAW_CONVERSATIONS_DIR, f))
      .find((f) => fs.readFileSync(f, 'utf8').includes('weekly digest'))!;
    n = llm.requests.length;
    const r3 = await run(e, ['--source', path.basename(old, '.md')]);
    assert.equal(r3.code, 0, r3.stderr);
    assert.equal(llm.requests.length - n, 1);
    assert.ok(llm.requests[llm.requests.length - 1]!.body.includes('weekly digest'));

    for (const bad of [['--since', 'yesterday'], ['--source', '../x'], ['--bogus'], ['--since']]) {
      assert.equal((await run(e, bad)).code, 2, bad.join(' '));
    }
  });

  it('anthropic: refuses without the data-leaves-machine flag; with it, sends only scrubbed text', async () => {
    const e = await makeEnv();
    writeConfig(e, {
      network: { allowedHosts: ['api.anthropic.com'] },
      llm: { provider: 'anthropic', model: 'claude-mock', baseUrl: llm.url, apiKeyEnv: 'EBRAIN_TEST_ANTHROPIC_KEY' },
    });
    const n = llm.requests.length;
    const before = checksumOutsideInbox(e.vault);
    const refused = await run(e, [], { EBRAIN_TEST_ANTHROPIC_KEY: 'test-key-123' });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--i-understand-data-leaves-machine/);
    assert.equal(llm.requests.length, n);
    assert.deepEqual(inboxFiles(e.vault), []);

    const noKey = await run(e, ['--i-understand-data-leaves-machine']);
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /EBRAIN_TEST_ANTHROPIC_KEY/);
    assert.equal(llm.requests.length, n);

    const r = await run(e, ['--i-understand-data-leaves-machine'], { EBRAIN_TEST_ANTHROPIC_KEY: 'test-key-123' });
    assert.equal(r.code, 0, r.stderr);
    const sent = llm.requests.slice(n);
    assert.equal(sent.length, 2);
    for (const q of sent) {
      assert.equal(q.path, '/v1/messages');
      assert.equal(q.headers['x-api-key'], 'test-key-123');
      for (const s of e.secrets) assert.ok(!q.body.includes(s), 'raw secret sent to the provider');
      assert.ok(!q.body.includes('test-key-123'));
    }
    assert.match(r.stdout, /4 candidates created/);
    assert.ok(!fs.readFileSync(e.configPath, 'utf8').includes('test-key-123'));
    assert.equal(checksumOutsideInbox(e.vault), before);
  });
});

describe('module layout', () => {
  const read = (dir: string): [string, string][] =>
    walk(path.join(repoRoot(), dir)).filter((f) => f.endsWith('.ts')).map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(repoRoot(), dir, f), 'utf8')]);

  it('provider code lives under src/llm/ and propose imports it; none under src/propose/', () => {
    const llmFiles = read('src/llm').map(([f]) => f);
    for (const f of ['src/llm/provider.ts', 'src/llm/openai-compatible.ts', 'src/llm/anthropic.ts', 'src/llm/schema.ts', 'src/llm/budget.ts', 'src/llm/prompts/propose.v1.ts']) {
      assert.ok(llmFiles.includes(f), f);
    }
    const propose = read('src/propose');
    assert.ok(propose.length > 0);
    assert.ok(propose.some(([, t]) => t.includes("from '../llm/")), 'propose imports src/llm/');
    for (const [f, t] of propose) {
      assert.ok(!/from '\.\.\/net\/|from '\.\.\/llm\/(?:openai-compatible|anthropic)\.js'|\bfetch\(|chat\/completions|v1\/messages|x-api-key|anthropic-version|createProvider/.test(t), f);
    }
    const cli = fs.readFileSync(path.join(repoRoot(), 'src/cli/propose-command.ts'), 'utf8');
    assert.ok(!/\bfetch\(|from '\.\.\/net\//.test(cli));
  });
});
