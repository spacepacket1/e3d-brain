// Phase 7: the secret and sensitive-data scrubber. Fixture corpus with
// precision/recall, no secret in any output, BIP39 mnemonic vs prose,
// idempotence, pathological inputs, strict (agent) mode, journal-text
// preservation, user literals, fail-safe writes, the dispatch/audit path for
// strict rejections, and `ebrain scrub`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuditLog, readAudit, segmentBytes } from '../src/audit/audit.js';
import { runScrub } from '../src/cli/scrub-command.js';
import { parseConfig } from '../src/config.js';
import { dispatch, registerTool, ToolRegistry, type DispatchContext } from '../src/mcp/dispatch.js';
import { scrubToolInput } from '../src/mcp/scrub-guard.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from '../src/scrub/bip39-english.js';
import { base58Decode, btcAddressValid, ibanValid, luhnValid, shannonEntropy, wifValid } from '../src/scrub/checks.js';
import { CREDENTIAL_TYPES, REDACT_ONLY_TYPES } from '../src/scrub/detectors.js';
import {
  DETECTOR_TYPES,
  formatFindings,
  MAX_EXTRA_PATTERN_LENGTH,
  MAX_EXTRA_PATTERNS,
  redactionToken,
  scrub,
  ScrubError,
  scrubForWrite,
  ScrubRejectedError,
  scrubVersion,
  type ScrubOptions,
} from '../src/scrub/index.js';
import { prng, realTmpDir, repoRoot, rmrf } from './helpers.js';
import {
  base58Check,
  EVM_ADDRESS,
  fake,
  fakeBtcAddress,
  fakeWif,
  GIT_SHA,
  luhnNumber,
  makeIban,
  NEGATIVES,
  NOTE_CITATION,
  POSITIVES,
  randomFrom,
  TX_HASH,
  ULID,
} from './scrub-fixtures.js';

const ALL_SECRETS = POSITIVES.flatMap((p) => p.secrets);

function text(r: ReturnType<typeof scrub>): string {
  assert.ok(r.ok, 'expected scrub to succeed');
  return r.text;
}

function assertNoSecret(haystack: string, secrets: readonly string[] = ALL_SECRETS): void {
  for (const s of secrets) assert.ok(!haystack.includes(s), 'output contains a raw fixture secret');
}

describe('scrub: bundled BIP39 list', () => {
  it('is the official English list', () => {
    assert.equal(BIP39_ENGLISH.length, 2048);
    assert.equal(new Set(BIP39_ENGLISH).size, 2048);
    assert.equal(createHash('sha256').update(`${BIP39_ENGLISH.join('\n')}\n`).digest('hex'), BIP39_ENGLISH_SHA256);
  });
});

describe('scrub: checks', () => {
  it('luhn', () => {
    assert.ok(luhnValid('4111111111111111'));
    assert.ok(!luhnValid('4111111111111112'));
    assert.ok(luhnValid(luhnNumber('37', 15)));
    assert.ok(!luhnValid('41a1'));
  });
  it('iban mod-97', () => {
    assert.ok(ibanValid('DE89370400440532013000'));
    assert.ok(ibanValid('GB82WEST12345698765432'));
    assert.ok(!ibanValid('DE89370400440532013001'));
    assert.ok(ibanValid(makeIban('NL', 'ABNA0417164300')));
  });
  it('base58check: WIF and addresses', () => {
    assert.ok(wifValid(fakeWif(true)));
    assert.ok(wifValid(fakeWif(false)));
    const w = fakeWif(true);
    assert.ok(!wifValid(`${w.slice(0, -1)}${w.endsWith('2') ? '3' : '2'}`));
    assert.ok(btcAddressValid(fakeBtcAddress()));
    assert.ok(!btcAddressValid(fakeWif(true)));
    assert.equal(base58Decode('0OIl'), undefined);
    assert.ok(!wifValid(base58Check(Buffer.alloc(33, 1))));
  });
  it('entropy', () => {
    assert.equal(shannonEntropy(''), 0);
    assert.equal(shannonEntropy('aaaa'), 0);
    assert.equal(shannonEntropy('abcd'), 2);
  });
  it('every detector type is either credential- or redact-only-class', () => {
    assert.deepEqual([...DETECTOR_TYPES].sort(), [...CREDENTIAL_TYPES, ...REDACT_ONLY_TYPES].sort());
    for (const t of DETECTOR_TYPES) assert.match(t, /^[a-z0-9-]{1,40}$/); // valid audit codes
  });
});

describe('scrub: fixture corpus', () => {
  it('has at least 60 positive and 60 negative cases', () => {
    assert.ok(POSITIVES.length >= 60, `positives: ${POSITIVES.length}`);
    assert.ok(NEGATIVES.length >= 60, `negatives: ${NEGATIVES.length}`);
    // Every credential and PII detector has a positive fixture.
    const covered = new Set(POSITIVES.map((p) => p.type));
    for (const t of DETECTOR_TYPES) if (t !== 'extra-pattern') assert.ok(covered.has(t), `no positive fixture for ${t}`);
  });

  it('redacts every positive, keeps negatives (precision/recall reported)', (t) => {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    const misses: string[] = [];
    for (const p of POSITIVES) {
      const r = scrub(p.text);
      const out = text(r);
      const leaked = p.secrets.some((s) => out.includes(s));
      const typed = r.findings.some((f) => f.type === p.type) && out.includes(redactionToken(p.type));
      if (!leaked && typed) tp++;
      else {
        fn++;
        misses.push(p.name);
      }
    }
    const falsePositives: string[] = [];
    for (const n of NEGATIVES) {
      const r = scrub(n.text);
      if (r.findings.length > 0 || text(r) !== n.text) {
        fp++;
        falsePositives.push(n.name);
      }
    }
    const recall = tp / (tp + fn);
    const precision = tp / (tp + fp);
    const fpRate = fp / NEGATIVES.length;
    t.diagnostic(
      `scrub corpus: positives ${POSITIVES.length}, negatives ${NEGATIVES.length}; ` +
        `recall ${(recall * 100).toFixed(1)}%, precision ${(precision * 100).toFixed(1)}%, ` +
        `false-positive rate ${(fpRate * 100).toFixed(1)}%`,
    );
    assert.deepEqual(misses, [], 'every positive is redacted');
    assert.ok(fpRate <= 0.02, `false positives: ${falsePositives.join(', ')}`);
  });

  it('never puts a secret in findings, errors, or rejections', () => {
    for (const p of POSITIVES) {
      for (const opts of [{}, { strict: true }] as ScrubOptions[]) {
        const r = scrub(p.text, opts);
        const serialized = JSON.stringify(r.ok ? r.findings : { findings: r.findings, rejection: r.rejection });
        assertNoSecret(serialized, p.secrets);
        assertNoSecret(formatFindings(r.findings), p.secrets);
        if (r.ok) assertNoSecret(r.text, p.secrets);
        else assert.ok(!('text' in r), 'a rejection carries no text');
      }
      try {
        scrubForWrite(p.text, { strict: true });
      } catch (err) {
        assert.ok(err instanceof ScrubRejectedError);
        assertNoSecret(`${err.message} ${JSON.stringify(err.rejection)}`, p.secrets);
      }
    }
  });

  it('reports findings as {type, count} only', () => {
    const k = fake.openai();
    const r = scrub(`a ${k} b ${k} c 123-45-6789`);
    assert.ok(r.ok);
    assert.deepEqual(r.findings, [
      { type: 'openai-key', count: 2 },
      { type: 'us-ssn', count: 1 },
    ]);
    assert.equal(r.text, `a ${redactionToken('openai-key')} b ${redactionToken('openai-key')} c ${redactionToken('us-ssn')}`);
  });
});

describe('scrub: BIP39 mnemonics', () => {
  it('redacts a 12-word mnemonic but not a 12-word ordinary sentence', () => {
    const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const r = scrub(`my wallet: ${mnemonic}`);
    assert.equal(text(r), `my wallet: ${redactionToken('bip39-mnemonic')}`);
    const sentence = 'We walked to the market and bought fresh bread for the family.';
    assert.equal(sentence.split(' ').length, 12);
    assert.deepEqual(scrub(sentence), { ok: true, text: sentence, findings: [] });
  });
  it('handles 12/15/18/21/24 words, capitalization, numbering, and commas', () => {
    for (const n of [12, 15, 18, 21, 24]) {
      const m = fake.mnemonic(n);
      assert.equal(text(scrub(m)), redactionToken('bip39-mnemonic'), `${n} words`);
    }
    const words = fake.mnemonic(12).split(' ');
    const capitalized = words.map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
    assert.equal(text(scrub(capitalized)), redactionToken('bip39-mnemonic'));
    assert.equal(text(scrub(words.join(', '))), redactionToken('bip39-mnemonic'));
    assert.equal(text(scrub(words.map((w, i) => `${i + 1}) ${w}`).join('  '))), `1) ${redactionToken('bip39-mnemonic')}`);
  });
  it('does not flag 11 list words or a run broken by a non-list word', () => {
    const words = fake.mnemonic(12).split(' ');
    assert.equal(scrub(words.slice(0, 11).join(' ')).findings.length, 0);
    const broken = [...words.slice(0, 6), 'the', ...words.slice(6)].join(' ');
    assert.equal(scrub(broken).findings.length, 0);
  });
});

describe('scrub: idempotence', () => {
  it('scrub(scrub(x)) == scrub(x) for every fixture', () => {
    for (const c of [...POSITIVES, ...NEGATIVES]) {
      const once = text(scrub(c.text));
      assert.equal(text(scrub(once)), once, c.name);
    }
  });
  it('holds for random mixtures of fixtures', () => {
    const r = prng(77);
    const pool = [...POSITIVES, ...NEGATIVES].map((c) => c.text);
    for (let i = 0; i < 200; i++) {
      const parts = Array.from({ length: 1 + Math.floor(r() * 6) }, () => pool[Math.floor(r() * pool.length)]!);
      const seps = [' ', '\n', '', ', ', '\n\n'];
      const sep = seps[Math.floor(r() * seps.length)]!;
      const mixed = parts.join(sep);
      const once = text(scrub(mixed));
      assert.equal(text(scrub(once)), once);
      // Fixtures on their own lines keep their context, so their secrets must
      // still go. (Glued with '' or ', ', words merge across fixtures and
      // line-start or word-boundary context legitimately changes.)
      if (sep.startsWith('\n')) assertNoSecret(once, POSITIVES.filter((p) => mixed.includes(p.text)).flatMap((p) => p.secrets));
    }
  });
  it('re-checks context after shrinking: a key pulled into the context window is still caught', () => {
    const filler = fake.github();
    const hex = fake.hex64();
    const once = text(scrub(`private: ${filler} ${hex}`));
    assert.ok(!once.includes(hex));
    assert.equal(text(scrub(once)), once);
  });
});

describe('scrub: pathological inputs', () => {
  const MB = 1 << 20;
  const cases: [string, string][] = [
    ['1 MB of a', 'a'.repeat(MB)],
    ['1 MB of digits', '1'.repeat(MB)],
    ['1 MB of hex', 'f'.repeat(MB)],
    ['repeated sk- prefixes', 'sk-'.repeat(MB / 3)],
    ['repeated eyJ', 'eyJ'.repeat(MB / 3)],
    ['repeated password=', 'password='.repeat(MB / 9)],
    ['repeated scheme', 'a://'.repeat(MB / 4)],
    ['repeated BEGIN', '-----BEGIN PRIVATE KEY-----\n'.repeat(MB / 28)],
    ['repeated bip39 words', 'abandon '.repeat(MB / 8)],
    ['random base64', randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', MB, prng(5))],
  ];
  for (const [name, input] of cases) {
    it(`${name} scrubs within the time bound`, { timeout: 10_000 }, () => {
      const started = process.hrtime.bigint();
      const r = scrub(input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(r.ok);
      assert.ok(ms < 5000, `${name} took ${ms.toFixed(0)} ms`);
    });
  }
  it('1 MB of a is unchanged', { timeout: 10_000 }, () => {
    const input = 'a'.repeat(MB);
    assert.equal(text(scrub(input)), input);
  });
});

describe('scrub: strict mode (agent principals)', () => {
  const agent: ScrubOptions = { principal: { type: 'agent' } };
  const pemKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${fake.pemBody(3)}\n-----END OPENSSH PRIVATE KEY-----`;
  const mnemonic = fake.mnemonic(12);
  const apiKey = fake.openai();

  for (const [name, input, type, secret] of [
    ['a fake private key', `note\n${pemKey}\n`, 'private-key', pemKey.split('\n')[1]!],
    ['a fake BIP39 mnemonic', `seed words ${mnemonic}`, 'bip39-mnemonic', mnemonic],
    ['a fake API key', `use ${apiKey}`, 'openai-key', apiKey],
  ] as const) {
    it(`rejects ${name} whole, naming only the detector type`, () => {
      const r = scrub(input, agent);
      assert.equal(r.ok, false);
      assert.ok(!r.ok);
      assert.deepEqual(r.rejection, { type: 'strict-scrub', detectors: [type] });
      assert.ok(!('text' in r));
      assertNoSecret(JSON.stringify(r), [secret]);
      assert.throws(() => scrubForWrite(input, agent), (err: unknown) => err instanceof ScrubRejectedError && !err.message.includes(secret));
      // A human principal gets redact-and-continue for the same text.
      const human = scrub(input, { principal: { type: 'human' } });
      assert.ok(human.ok);
      assert.ok(!human.text.includes(secret));
    });
  }

  it('rejects every credential-class positive fixture', () => {
    for (const p of POSITIVES.filter((x) => (CREDENTIAL_TYPES as readonly string[]).includes(x.type))) {
      const r = scrub(p.text, agent);
      assert.equal(r.ok, false, p.name);
    }
  });

  it('preserves a public 0x address in otherwise clean text', () => {
    const input = `Sent 0.5 ETH to ${EVM_ADDRESS} after review.`;
    assert.deepEqual(scrub(input, agent), { ok: true, text: input, findings: [] });
  });

  it('redacts and continues for PII and the entropy heuristic', () => {
    const card = luhnNumber('4', 16);
    const blob = randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 40, prng(9));
    const input = `card ${card}, ssn 123-45-6789, routing number 021000021, blob ${blob}`;
    const r = scrub(input, agent);
    assert.ok(r.ok);
    assert.deepEqual(
      r.findings.map((f) => f.type),
      ['credit-card', 'us-ssn', 'bank-routing', 'high-entropy'],
    );
    assertNoSecret(r.text, [card, '123-45-6789', '021000021', blob]);
  });
});

describe('scrub: agent journal text', () => {
  it('preserves tx hashes, git SHAs, ULIDs, and citations; redacts a 64-hex next to "private key"', () => {
    const key = fake.hex64();
    const journal = [
      `2026-10-14 swap executed: ${TX_HASH} (gas 21000) from ${EVM_ADDRESS}`,
      `deployed ${GIT_SHA} to staging; recall_id ${ULID}`,
      `basis: ${NOTE_CITATION}, thesis:eth_l2_fees_fall, outcome:q3_review_2026, commit:${GIT_SHA}`,
      `content hash ${randomFrom('0123456789abcdef', 64)} matched`,
      `rotated the signer; old private key ${key} is retired`,
    ].join('\n');
    const r = scrub(journal, { principal: { type: 'human' } });
    assert.ok(r.ok);
    for (const keep of [TX_HASH, EVM_ADDRESS, GIT_SHA, ULID, NOTE_CITATION, 'thesis:eth_l2_fees_fall', 'outcome:q3_review_2026', `commit:${GIT_SHA}`]) {
      assert.ok(r.text.includes(keep), `kept ${keep.slice(0, 12)}`);
    }
    assert.ok(!r.text.includes(key));
    assert.deepEqual(r.findings, [{ type: 'hex-private-key', count: 1 }]);
    // The agent writing that same journal is rejected because of the key alone.
    const strict = scrub(journal, { principal: { type: 'agent' } });
    assert.ok(!strict.ok);
    assert.deepEqual(strict.rejection.detectors, ['hex-private-key']);
    assert.equal(scrub(journal.split('\n').slice(0, 4).join('\n'), { principal: { type: 'agent' } }).ok, true);
  });

  it('uses a short window: a 64-hex far from a key-context word is not a key', () => {
    const hex = fake.hex64();
    const far = `the private notes are elsewhere; this line just says hello and then lists ${hex}`;
    assert.equal(text(scrub(far)), far);
    assert.equal(text(scrub(`${hex}\nprivate`)), `${hex}\nprivate`); // other line
    for (const word of ['private', 'secret', 'priv', 'seed', 'mnemonic']) {
      assert.ok(!text(scrub(`${word}: ${hex}`)).includes(hex), word);
    }
  });
});

describe('scrub: extraPatterns (user literals)', () => {
  it('redacts literals case-sensitively', () => {
    const r = scrub('Project NIGHTJAR-42 vs nightjar-42', { extraPatterns: ['NIGHTJAR-42'] });
    assert.ok(r.ok);
    assert.equal(r.text, `Project ${redactionToken('extra-pattern')} vs nightjar-42`);
    assert.deepEqual(r.findings, [{ type: 'extra-pattern', count: 1 }]);
    // Overlapping literals: the longest wins.
    assert.equal(text(scrub('abcdefgh', { extraPatterns: ['abcd', 'abcdefgh'] })), redactionToken('extra-pattern'));
    // Literals redact and continue even for agents.
    assert.equal(scrub('code ZEBRA77', { extraPatterns: ['ZEBRA77'], strict: true }).ok, true);
  });
  it('enforces length and count limits (fail-safe: throws, message has no literal)', () => {
    for (const bad of [['abc'], ['x'.repeat(MAX_EXTRA_PATTERN_LENGTH + 1)], Array.from({ length: MAX_EXTRA_PATTERNS + 1 }, (_, i) => `pattern${i}`), ['with\nnewline']]) {
      assert.throws(
        () => scrub('text', { extraPatterns: bad }),
        (err: unknown) => err instanceof ScrubError && !err.message.includes('newline') && !err.message.includes('pattern1'),
      );
    }
  });
  it('config validates scrub.extraPatterns with the same limits', () => {
    const base = { vaultPath: '/tmp/v', stateDir: '/tmp/s', principal: { id: 'a', type: 'human' }, mode: 'inbox' };
    assert.deepEqual(parseConfig({ ...base, scrub: { extraPatterns: ['ProjectX'] } }).scrub.extraPatterns, ['ProjectX']);
    assert.throws(() => parseConfig({ ...base, scrub: { extraPatterns: ['ab'] } }), /scrub\.extraPatterns/);
    assert.throws(() => parseConfig({ ...base, scrub: { extraPatterns: Array.from({ length: 65 }, (_, i) => `literal-${i}`) } }), /at most 64/);
  });
});

describe('scrub: fail-safe writes', () => {
  /** A minimal writer in the Phase 8/9 shape: scrub, then persist; abort on any throw. */
  function write(store: string[], body: string, opts: ScrubOptions): void {
    const s = scrubForWrite(body, opts);
    store.push(`---\nscrubVersion: ${s.scrubVersion}\n---\n${s.text}`);
  }
  it('stamps scrubVersion and stores only scrubbed text', () => {
    const store: string[] = [];
    const k = fake.openai();
    write(store, `hello ${k}`, {});
    assert.equal(store.length, 1);
    assert.ok(store[0]!.includes(`scrubVersion: ${scrubVersion}`));
    assert.ok(!store[0]!.includes(k));
    assert.equal(typeof scrubVersion, 'number');
  });
  it('aborts the write when scrubbing throws or rejects', () => {
    const store: string[] = [];
    assert.throws(() => write(store, 'body', { extraPatterns: ['no'] }), ScrubError);
    assert.throws(() => write(store, 'body', { entropyThreshold: -1 }), ScrubError);
    assert.throws(() => write(store, 42 as unknown as string, {}), ScrubError);
    assert.throws(() => write(store, `k ${fake.openai()}`, { principal: { type: 'agent' } }), ScrubRejectedError);
    assert.deepEqual(store, []);
  });
  it('the entropy threshold is tunable', () => {
    const slugish = 'Release2026Candidate7Build9Final3Notes';
    assert.equal(scrub(slugish).findings.length, 0);
    assert.deepEqual(scrub(slugish, { entropyThreshold: 3 }).findings, [{ type: 'high-entropy', count: 1 }]);
  });
});

describe('scrub: strict rejection through dispatch and the audit log', () => {
  it('a write tool rejects an agent body, stores nothing, and audits the detector type only', async () => {
    const dir = realTmpDir('ebrain-scrub-');
    try {
      const stateDir = ensurePrivateDir(path.join(dir, 'state'));
      const audit = new AuditLog(stateDir, { maxSegmentBytes: segmentBytes(50) });
      const registry = new ToolRegistry();
      const stored: string[] = [];
      registerTool(
        {
          name: 'fake_write',
          modes: ['journal'],
          schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
          handler: (args: { body: string }, ctx) => {
            const s = scrubToolInput(args.body, ctx);
            stored.push(s.text);
            return { content: 'stored', count: 1 };
          },
        },
        registry,
      );
      const ctx: DispatchContext = { mode: 'journal', principal: { id: 'bot', type: 'agent' }, maxCharsPerCall: 10000, registry, audit };
      const key = fake.anthropic();
      const res = await dispatch(ctx, 'fake_write', { body: `remember ${key}` });
      assert.equal(res.isError, true);
      assert.equal(res.structuredContent?.error.type, 'strict-scrub');
      assert.ok(res.structuredContent?.error.detail.includes('anthropic-key'));
      assert.ok(!JSON.stringify(res).includes(key));
      assert.deepEqual(stored, []);

      const ok = await dispatch(ctx, 'fake_write', { body: 'card 123-45-6789 noted' });
      assert.ok(!ok.isError);
      assert.deepEqual(stored, [`card ${redactionToken('us-ssn')} noted`]);

      const raw = fs.readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8');
      assert.ok(!raw.includes(key) && !raw.includes('123-45-6789'));
      const lines = readAudit(stateDir).lines;
      assert.equal(lines.length, 2);
      assert.equal(lines[0]!.outcome, 'rejected');
      assert.deepEqual(lines[0]!.error, { type: 'strict-scrub', code: 'anthropic-key' });
      assert.equal(lines[1]!.outcome, 'ok');
    } finally {
      rmrf(dir);
    }
  });
});

describe('ebrain scrub', () => {
  const fixture = (): string =>
    [
      '# Leaky note',
      `openai ${fake.openai()}`,
      `github ${fake.github()}`,
      'password=Tr0ub4dor&3',
      `private key: ${fake.hex64()}`,
      'ssn 123-45-6789',
      `tx ${TX_HASH}`,
      '',
    ].join('\n');

  it('redacts a fixture file and prints finding counts only', () => {
    const dir = realTmpDir('ebrain-scrub-cli-');
    try {
      const input = fixture();
      const file = path.join(dir, 'note.md');
      fs.writeFileSync(file, input);
      const env = { EBRAIN_CONFIG: path.join(dir, 'missing.json') };
      const r = runScrub([file], { env });
      assert.equal(r.code, 0, r.stderr);
      const secrets = input.split('\n').flatMap((l) => l.split(' ')).filter((w) => w.length >= 9 && !w.startsWith('0x') && w !== 'password=Tr0ub4dor&3');
      secrets.push('Tr0ub4dor&3', '123-45-6789');
      assertNoSecret(r.stdout + r.stderr, secrets);
      assert.ok(r.stdout.includes(TX_HASH));
      assert.equal(
        r.stderr,
        'findings:\nhex-private-key: 1\nopenai-key: 1\ngithub-token: 1\npassword-assignment: 1\nus-ssn: 1\n',
      );
      const strict = runScrub([file, '--strict'], { env });
      assert.equal(strict.code, 3);
      assert.equal(strict.stdout, '');
      assert.match(strict.stderr, /rejected \(strict\): hex-private-key, openai-key, github-token, password-assignment\n$/);
      assertNoSecret(strict.stderr, secrets);
      const stdin = runScrub(['-'], { env, readStdin: () => Buffer.from('nothing to see') });
      assert.deepEqual(stdin, { code: 0, stdout: 'nothing to see', stderr: 'findings: none\n' });
      assert.equal(runScrub([], { env }).code, 2);
      assert.equal(runScrub([file, '--bogus'], { env }).code, 2);
      assert.equal(runScrub([path.join(dir, 'nope.md')], { env }).code, 1);
    } finally {
      rmrf(dir);
    }
  });

  it('uses scrub.extraPatterns from the config', () => {
    const dir = realTmpDir('ebrain-scrub-cfg-');
    try {
      const cfg = path.join(dir, 'config.json');
      fs.writeFileSync(
        cfg,
        JSON.stringify({ vaultPath: path.join(dir, 'vault'), stateDir: path.join(dir, 'state'), principal: { id: 'me', type: 'human' }, mode: 'inbox', scrub: { extraPatterns: ['Codename-Falcon'] } }),
        { mode: 0o600 },
      );
      const r = runScrub(['-'], { env: { EBRAIN_CONFIG: cfg }, readStdin: () => Buffer.from('about Codename-Falcon') });
      assert.deepEqual(r, { code: 0, stdout: `about ${redactionToken('extra-pattern')}`, stderr: 'findings:\nextra-pattern: 1\n' });
    } finally {
      rmrf(dir);
    }
  });

  it('runs from the built CLI with stdin', () => {
    const main = path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
    const key = fake.openai();
    const r = spawnSync(process.execPath, [main, 'scrub', '-'], {
      input: `k=${key}\n`,
      env: { ...process.env, EBRAIN_CONFIG: path.join(realTmpDir(), 'none.json') },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `k=${redactionToken('openai-key')}\n`);
    assert.equal(r.stderr, 'findings:\nopenai-key: 1\n');
    const help = execFileSync(process.execPath, [main, '--help'], { encoding: 'utf8' });
    assert.match(help, /scrub <file\|->/);
  });
});
