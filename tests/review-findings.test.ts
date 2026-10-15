// Regression tests for the findings of the independent security review (2026-10-15):
// inline-code masking must be linear, CLI output must not carry terminal control sequences,
// and a wallet key labelled on the previous line must be caught.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { terminalSafe } from '../src/cli/terminal.js';
import { maskInlineCode } from '../src/vault/markdown.js';
import { scrub } from '../src/scrub/scrub.js';

describe('maskInlineCode', () => {
  it('masks a code span and leaves the rest', () => {
    assert.equal(maskInlineCode('see `[[x]]` and [[y]]'), 'see         and [[y]]');
    assert.equal(maskInlineCode('a ``code with ` tick`` b'), `a ${' '.repeat(20)} b`);
    assert.equal(maskInlineCode('an `unclosed span'), 'an `unclosed span');
    assert.equal(maskInlineCode('no ticks'), 'no ticks');
  });

  it('pairs a run only with a later run of the same length', () => {
    assert.equal(maskInlineCode('`a``b`'), '      ');
    assert.equal(maskInlineCode('``a`b``'), '       ');
  });

  it('is linear on adversarial backtick lines (was ~10 s at 5,000)', () => {
    for (const line of ['x' + '`'.repeat(100_000), '`'.repeat(100_000), '`a'.repeat(50_000), '`'.repeat(1) + 'x'.repeat(100_000)]) {
      const t = Date.now();
      maskInlineCode(line);
      assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
    }
  });
});

describe('terminalSafe', () => {
  it('removes escape sequences, carriage returns and bidi overrides, keeping newlines and tabs', () => {
    const out = terminalSafe('a\x1b[2J\x1b[1;1HFAKE\r\x1b]8;;http://evil\x07link‮evil\n\tok');
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮]/.test(out), JSON.stringify(out));
    assert.ok(out.includes('\n\tok'));
    assert.ok(out.startsWith('a'));
  });
});

describe('hex private keys labelled outside their own line', () => {
  const key = '0x' + 'ab12cd34'.repeat(8);
  const strict = { strict: true } as const;
  for (const [name, text] of [
    ['label on the previous line', `Here is my wallet key\n${key}`],
    ['split JSON key', `{"privateKey":\n "${key}"}`],
    ['pk label', `pk ${key}`],
    ['deployer label', `deployer: ${key}`],
  ] as const) {
    it(`flags: ${name}`, () => {
      const r = scrub(text, strict);
      assert.equal(r.ok, false, 'a strict (agent) write containing a hex private key must be rejected');
    });
  }

  it('still leaves a bare transaction hash alone', () => {
    const r = scrub(`tx hash\n${key}`, strict);
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.text.includes(key));
  });
});
