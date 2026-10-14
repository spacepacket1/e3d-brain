import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNoteCitation, CitationError, formatCitation, parseCitation, type Citation, type NoteCitation,
} from '../src/cite/citation.js';
import { prng } from './helpers.js';

const REV = '0123456789abcdef';

function roundTrip(c: Citation): string {
  const s = formatCitation(c);
  const parsed = parseCitation(s);
  assert.ok(parsed.ok, `${s}: ${parsed.ok ? '' : parsed.error}`);
  assert.deepEqual(parsed.citation, c, s);
  assert.equal(formatCitation(parsed.citation), s);
  return s;
}

function rejects(input: unknown): void {
  const r = parseCitation(input);
  assert.equal(r.ok, false, `accepted ${JSON.stringify(input)}`);
}

describe('citation grammar: round trip', () => {
  it('every kind round-trips with its canonical string', () => {
    const cases: [Citation, string][] = [
      [{ kind: 'note', id: '01JALPHA0000000000000000AA', rev: REV }, `note:01JALPHA0000000000000000AA@${REV}`],
      [{ kind: 'note', id: 'prov_abc', rev: REV, heading: 'Design' }, `note:prov_abc@${REV}#Design`],
      [{ kind: 'note', id: 'x', rev: REV, turns: { from: 3, to: 7 } }, `note:x@${REV}#turns-3-7`],
      [{ kind: 'note', id: 'x', rev: REV, turns: { from: 0, to: 0 } }, `note:x@${REV}#turns-0-0`],
      [{ kind: 'ref', refId: 'abc123', chapter: 'ch3', ordinal: 12 }, 'ref:abc123/ch3/12'],
      [{ kind: 'thesis', id: '42' }, 'thesis:42'],
      [{ kind: 'outcome', id: 'out_9' }, 'outcome:out_9'],
      [{ kind: 'commit', sha: 'abc1234' }, 'commit:abc1234'],
      [{ kind: 'commit', sha: 'a'.repeat(40) }, `commit:${'a'.repeat(40)}`],
      [{ kind: 'url', url: 'https://example.com/post' }, 'url:https://example.com/post'],
      [{ kind: 'url', url: 'https://example.com/p?q=1&r=2' }, 'url:https://example.com/p?q=1&r=2'],
    ];
    for (const [c, s] of cases) assert.equal(roundTrip(c), s);
  });

  it('headings with @, #, spaces, commas, brackets, %, and non-ASCII survive', () => {
    const headings = [
      'Design @ scale, part #2', 'a b', '[x](y) {z} <w>', '100% done', 'Café Ünïcode', 'αλφα', '日本語の見出し',
      'emoji 🎉', 'quote "q" \'s\'', 'back\\slash', 'turns-1-2', 'turns-', '   ', '-._~', 'zero\u200Dwidth',
    ];
    for (const heading of headings) {
      const s = roundTrip({ kind: 'note', id: 'n1', rev: REV, heading });
      const frag = s.slice(s.indexOf('#') + 1);
      assert.match(frag, /^[A-Za-z0-9\-._~%]+$/, s);
      assert.doesNotMatch(frag, /[@#\s,[\](){}<>]/, s);
    }
    assert.equal(formatCitation({ kind: 'note', id: 'n', rev: REV, heading: 'A b, c@d#e' }), `note:n@${REV}#A%20b%2C%20c%40d%23e`);
    // A heading that looks like the reserved turn range stays a heading.
    assert.equal(formatCitation({ kind: 'note', id: 'n', rev: REV, heading: 'turns-1-2' }), `note:n@${REV}#turns%2D1-2`);
  });

  it('urls with fragments, userinfo-like paths, commas, and spaces are encoded', () => {
    for (const url of [
      'https://example.com/page#fragment', 'https://example.com/a,b', 'https://example.com/a%20b',
      'https://example.com/@user', 'https://example.com/x?y=[1]', 'https://例え.jp/パス',
    ]) {
      const s = roundTrip({ kind: 'url', url });
      assert.doesNotMatch(s.slice(4), /[@#\s,[\]]/, s);
    }
    assert.equal(formatCitation({ kind: 'url', url: 'https://e.com/a%20b#f' }), 'url:https://e.com/a%2520b%23f');
  });

  it('random headings round-trip (property)', () => {
    const rand = prng(3);
    const alphabet = ['a', 'Z', '0', ' ', '@', '#', ',', '%', '[', ']', '-', '.', '~', '/', 'é', '日', '🎉', '_', '+'];
    for (let i = 0; i < 500; i++) {
      const len = 1 + Math.floor(rand() * 20);
      let heading = '';
      for (let j = 0; j < len; j++) heading += alphabet[Math.floor(rand() * alphabet.length)];
      roundTrip({ kind: 'note', id: 'n', rev: REV, heading });
    }
  });
});

describe('citation grammar: malformed and hostile input', () => {
  it('rejects malformed citations', () => {
    const bad = [
      '', 'note', 'note:', 'note:abc', `note:abc@`, `note:@${REV}`, `note:a-b@${REV}`, `note:a b@${REV}`,
      `note:abc@${REV.toUpperCase()}`, `note:abc@${REV.slice(1)}`, `note:abc@${REV}0`, `note:abc@${REV}#`,
      `note:abc@${REV}#a b`, `note:abc@${REV}#a,b`, `note:abc@${REV}#a@b`, `note:abc@${REV}#a#b`, `note:abc@${REV}#[x]`,
      `note:abc@${REV}@${REV}`, `NOTE:abc@${REV}`, `Note:abc@${REV}`, `note:abc@${REV}#turns-2-1`,
      `note:abc@${REV}#turns-01-2`, `note:abc@${REV}#turns-1`, `note:abc@${REV}#turns-a-b`, `note:abc@${REV}#turns-1-2-3`,
      `note:abc@${REV}#turns-99999999999-99999999999`,
      'ref:abc/ch1', 'ref:abc/ch1/01', 'ref:abc/ch1/-1', 'ref:abc/ch 1/1', 'ref:a/b/c/1', 'ref://1',
      'thesis:', 'thesis:4 2', 'thesis:a-b', 'outcome:../x', 'commit:abc', 'commit:ABC1234', 'commit:xyz1234',
      `commit:${'a'.repeat(65)}`, 'url:', 'url:http://example.com', 'url:ftp://example.com', 'url:javascript:alert(1)',
      'url:https://', 'url:https:example.com', 'url:HTTPS://example.com', 'url:https://example.com/a b',
      'url:https://example.com/a,b', 'url:https://example.com/#f', 'unknown:x', ':x', 'note:abc@' + REV + ' ',
      ' thesis:1', 'thesis:1\n',
    ];
    for (const s of bad) rejects(s);
  });

  it('rejects hostile input: non-strings, huge strings, control characters, bidi, credentials, bad encodings', () => {
    for (const v of [undefined, null, 42, {}, ['thesis:1'], Symbol.iterator]) rejects(v);
    rejects(`thesis:${'a'.repeat(5000)}`);
    rejects(`thesis:${'a'.repeat(129)}`);
    rejects(`note:abc@${REV}#${'A'.repeat(600)}`);
    rejects('thesis:1\u0000');
    rejects('thesis:‮1');
    rejects('thesis:１'); // fullwidth digit
    rejects(`note:abc@${REV}#%0A`); // newline in a heading
    rejects(`note:abc@${REV}#%1B%5B31m`); // terminal escape
    rejects(`note:abc@${REV}#%E2%80%AEevil`); // RLO override
    rejects(`note:abc@${REV}#%FF`); // invalid UTF-8
    rejects(`note:abc@${REV}#%C0%AF`); // overlong encoding
    rejects(`note:abc@${REV}#%ED%A0%80`); // surrogate
    rejects(`note:abc@${REV}#%2`); // truncated escape
    rejects(`note:abc@${REV}#%zz`);
    rejects(`note:abc@${REV}#%2c`); // lowercase hex is not canonical
    rejects(`note:abc@${REV}#%41`); // escaped safe character is not canonical
    rejects(`note:abc@${REV}#%EF%BB%BFx`.replace('#%EF%BB%BF', '#﻿'));
    rejects('url:https://user:pass%40evil.com@good.com/');
    rejects('url:https://user%40good.com/'.replace('%40', '@'));
    rejects('url:https://good.com%40evil.com/'); // decodes to userinfo
    rejects('url:https://evil.com%5C%40good.com/'); // backslash
    rejects('url:https://example.com/%0Ainjected');
    rejects('url:https://example.com/%20');
    rejects(`url:https://example.com/${'a'.repeat(2100)}`);
  });

  it('formatCitation refuses invalid citations', () => {
    const bad: Citation[] = [
      { kind: 'note', id: 'a-b', rev: REV },
      { kind: 'note', id: 'a', rev: 'xyz' },
      { kind: 'note', id: 'a', rev: REV, heading: '' },
      { kind: 'note', id: 'a', rev: REV, heading: 'line\nbreak' },
      { kind: 'note', id: 'a', rev: REV, heading: 'tab\there' },
      { kind: 'note', id: 'a', rev: REV, heading: 'h', turns: { from: 1, to: 2 } },
      { kind: 'note', id: 'a', rev: REV, turns: { from: 2, to: 1 } },
      { kind: 'note', id: 'a', rev: REV, turns: { from: 1.5, to: 2 } },
      { kind: 'ref', refId: 'r', chapter: 'c', ordinal: -1 },
      { kind: 'commit', sha: 'abc' },
      { kind: 'url', url: 'http://example.com/' },
      { kind: 'url', url: 'https://u:p@example.com/' },
      { kind: 'thesis', id: '' },
    ];
    for (const c of bad) assert.throws(() => formatCitation(c), CitationError, JSON.stringify(c));
  });
});

describe('checkNoteCitation', () => {
  it('is fresh, stale, or missing against an injected lookup', () => {
    const revs = new Map([['a', REV], ['b', 'fedcba9876543210']]);
    const lookup = (id: string) => (revs.has(id) ? { rev: revs.get(id)! } : undefined);
    const cite = (id: string, heading?: string): NoteCitation => ({ kind: 'note', id, rev: REV, ...(heading ? { heading } : {}) });
    assert.equal(checkNoteCitation(cite('a'), lookup), 'fresh');
    assert.equal(checkNoteCitation(cite('a', 'Some heading'), lookup), 'fresh');
    assert.equal(checkNoteCitation(cite('b'), lookup), 'stale');
    assert.equal(checkNoteCitation(cite('c'), lookup), 'missing');
  });
});
