// Phase 7 scrubber fixture corpus. Every "secret" here is synthetic: random
// bytes from a seeded PRNG, formatted like the real thing (valid Luhn / mod-97 /
// base58check where the detector checks them). Provider-shaped strings are
// assembled at runtime from pieces so the repository itself holds no literal
// that a secret scanner would flag.

import { createHash } from 'node:crypto';
import { BIP39_ENGLISH } from '../src/scrub/bip39-english.js';
import type { DetectorType } from '../src/scrub/index.js';
import { prng } from './helpers.js';

export interface PositiveCase {
  name: string;
  text: string;
  /** Substrings that must not survive scrubbing. */
  secrets: string[];
  type: DetectorType;
}

export interface NegativeCase {
  name: string;
  text: string;
}

const rand = prng(0x5c7b);
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = `${ALNUM}+/`;
const HEX = '0123456789abcdef';
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function randomFrom(alphabet: string, n: number, r: () => number = rand): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

/** Random string from `alphabet` that contains an upper, a lower, and a digit. */
function mixed(alphabet: string, n: number): string {
  for (;;) {
    const s = randomFrom(alphabet, n);
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
}

const j = (...parts: string[]): string => parts.join('');

// --- Synthetic credential builders ---------------------------------------

export const fake = {
  openai: (): string => j('s', 'k-', mixed(ALNUM, 48)),
  openaiProject: (): string => j('s', 'k-', 'proj-', mixed(`${ALNUM}_-`, 64)),
  anthropic: (): string => j('s', 'k-', 'ant-', 'api03-', mixed(`${ALNUM}_-`, 80), 'AA'),
  awsId: (prefix = 'AKIA'): string => j(prefix, randomFrom(UPPER_NUM, 16)),
  awsSecret: (): string => mixed(B64, 40),
  github: (kind = 'ghp'): string => j(kind, '_', mixed(ALNUM, 36)),
  githubPat: (): string => j('github', '_pat_', mixed(ALNUM, 22), '_', mixed(ALNUM, 59)),
  slack: (kind = 'b'): string => j('xo', 'x', kind, '-', randomFrom('0123456789', 12), '-', randomFrom('0123456789', 13), '-', mixed(ALNUM, 24)),
  stripe: (kind = 'sk'): string => j(kind, '_li', 've_', mixed(ALNUM, 24)),
  google: (): string => j('AI', 'za', 'Sy', mixed(`${ALNUM}_-`, 33)),
  jwt: (): string => {
    const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    return [b64u({ alg: 'HS256', typ: 'JWT' }), b64u({ sub: randomFrom(HEX, 12), iat: 1760000000 }), mixed(`${ALNUM}_-`, 43)].join('.');
  },
  hex64: (): string => randomFrom(HEX, 64),
  pemBody: (lines: number): string => Array.from({ length: lines }, () => mixed(B64, 64)).join('\n'),
  mnemonic: (words: number): string => Array.from({ length: words }, () => BIP39_ENGLISH[Math.floor(rand() * 2048)]!).join(' '),
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

function sha256(b: Uint8Array): Buffer {
  return createHash('sha256').update(b).digest();
}

export function base58Check(payload: Uint8Array): string {
  const check = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, check]));
}

export function fakeWif(compressed: boolean): string {
  const key = Buffer.from(randomFrom(HEX, 64), 'hex');
  return base58Check(Buffer.concat([Buffer.from([0x80]), key, compressed ? Buffer.from([0x01]) : Buffer.alloc(0)]));
}

export function fakeBtcAddress(): string {
  return base58Check(Buffer.concat([Buffer.from([0x00]), Buffer.from(randomFrom(HEX, 40), 'hex')]));
}

/** A Luhn-valid number with the given prefix and length. */
export function luhnNumber(prefix: string, length: number): string {
  let body = prefix + randomFrom('0123456789', length - prefix.length - 1);
  for (let d = 0; d <= 9; d++) {
    const cand = body + d;
    let sum = 0;
    for (let i = 0; i < cand.length; i++) {
      let v = Number(cand[cand.length - 1 - i]);
      if (i % 2 === 1) {
        v *= 2;
        if (v > 9) v -= 9;
      }
      sum += v;
    }
    if (sum % 10 === 0) return cand;
  }
  body = '';
  return body;
}

function mod97(numeric: string): number {
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

export function makeIban(country: string, bban: string): string {
  const numeric = (bban + country + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const check = String(98 - mod97(numeric)).padStart(2, '0');
  return country + check + bban;
}

function group4(s: string, sep = ' '): string {
  return s.replace(/(.{4})(?=.)/g, `$1${sep}`);
}

// --- Positive cases --------------------------------------------------------

function pem(label: string, lines: number, terminated = true): { text: string; body: string } {
  const body = fake.pemBody(lines);
  const text = j('-----BEGIN ', label, '-----\n', body, terminated ? j('\n-----END ', label, '-----') : '');
  return { text, body };
}

function buildPositives(): PositiveCase[] {
  const out: PositiveCase[] = [];
  const add = (name: string, type: DetectorType, text: string, ...secrets: string[]): void => {
    out.push({ name, type, text, secrets });
  };

  // PEM / OpenSSH blocks.
  for (const [label, lines] of [
    ['RSA PRIVATE KEY', 6],
    ['OPENSSH PRIVATE KEY', 5],
    ['EC PRIVATE KEY', 3],
    ['ENCRYPTED PRIVATE KEY', 4],
    ['PGP PRIVATE KEY BLOCK', 4],
    ['PRIVATE KEY', 4],
  ] as const) {
    const p = pem(label, lines);
    add(`pem ${label}`, 'private-key', `Server key below:\n${p.text}\nend of note`, p.body, ...p.body.split('\n'));
  }
  {
    const p = pem('OPENSSH PRIVATE KEY', 3, false);
    add('pem without footer', 'private-key', `pasted half a key:\n${p.text}\n\nThen the rest of the note.`, ...p.body.split('\n'));
  }

  // Provider keys and tokens.
  const k1 = fake.openai();
  add('openai legacy key', 'openai-key', `Use ${k1} for the batch job.`, k1);
  const k2 = fake.openaiProject();
  add('openai project key', 'openai-key', `OPENAI_API_KEY=${k2}`, k2);
  const k3 = fake.openai();
  add('openai key in json', 'openai-key', `{"apiKey": "${k3}"}`, k3);
  const k4 = fake.anthropic();
  add('anthropic key', 'anthropic-key', `export ANTHROPIC_API_KEY=${k4}`, k4);
  const k5 = fake.anthropic();
  add('anthropic key in prose', 'anthropic-key', `the key ${k5} was leaked in chat`, k5);
  const a1 = fake.awsId();
  add('aws access key id', 'aws-access-key', `aws_access_key_id = ${a1}`, a1);
  const a2 = fake.awsId('ASIA');
  add('aws session key id', 'aws-access-key', `temporary creds ${a2} expire soon`, a2);
  const a3 = fake.awsId();
  const s3 = fake.awsSecret();
  add('aws key pair', 'aws-secret-key', `[default]\naws_access_key_id = ${a3}\naws_secret_access_key = ${s3}\n`, a3, s3);
  const g1 = fake.github('ghp');
  add('github classic token', 'github-token', `git clone with token ${g1}`, g1);
  const g2 = fake.github('gho');
  add('github oauth token', 'github-token', `GH_TOKEN=${g2}`, g2);
  const g3 = fake.githubPat();
  add('github fine-grained pat', 'github-token', `pat: ${g3}`, g3);
  const sl1 = fake.slack('b');
  add('slack bot token', 'slack-token', `SLACK_BOT=${sl1}`, sl1);
  const sl2 = fake.slack('p');
  add('slack user token', 'slack-token', `user token ${sl2} for the export`, sl2);
  const st1 = fake.stripe('sk');
  add('stripe secret key', 'stripe-key', `stripe.api_key = "${st1}"`, st1);
  const st2 = fake.stripe('rk');
  add('stripe restricted key', 'stripe-key', `restricted ${st2}`, st2);
  const go1 = fake.google();
  add('google api key', 'google-api-key', `maps key ${go1} in the config`, go1);
  const go2 = fake.google();
  add('google api key in url', 'google-api-key', `https://maps.googleapis.com/maps/api/geocode/json?key=${go2}`, go2);
  const jw1 = fake.jwt();
  add('jwt', 'jwt', `session=${jw1}`, jw1);
  const jw2 = fake.jwt();
  add('jwt in prose', 'jwt', `The cookie held ${jw2} until logout.`, jw2);
  const bt1 = mixed(`${ALNUM}._-`, 40);
  add('bearer header', 'bearer-token', `Authorization: Bearer ${bt1}`, bt1);
  const bt2 = mixed(ALNUM, 32);
  add('bearer in curl', 'bearer-token', `curl -H "Authorization: bearer ${bt2}" https://api.example.com/v1/items`, bt2);

  // Password assignments and URL credentials.
  add('password equals', 'password-assignment', 'password=Tr0ub4dor&3', 'Tr0ub4dor&3');
  add('passwd colon', 'password-assignment', 'passwd: s3cr3t-Value!', 's3cr3t-Value!');
  add('pwd equals', 'password-assignment', 'login with user=admin pwd=Adm1nPass2026', 'Adm1nPass2026');
  add('secret equals', 'password-assignment', 'CLIENT_SECRET=9fQ2-kLm8-Zp4x', '9fQ2-kLm8-Zp4x');
  add('token colon yaml', 'password-assignment', 'auth:\n  token: tkn_8842_ab19_ff02\n', 'tkn_8842_ab19_ff02');
  add('api_key equals', 'password-assignment', 'api_key=ak_test_77291xq', 'ak_test_77291xq');
  add('json password', 'password-assignment', '{"user": "chris", "password": "correct horse battery"}', 'correct horse battery');
  add('password is', 'password-assignment', 'FYI my wifi password is hunter2 for guests', 'hunter2');
  add('db password env letters only', 'password-assignment', 'DB_PASSWORD=swordfish\nDB_HOST=localhost', 'swordfish');
  add('apiKey quoted', 'password-assignment', "const apiKey: 'Kx92-Lm33-Qp71';", 'Kx92-Lm33-Qp71');
  add('postgres url credentials', 'url-credentials', 'DATABASE_URL=postgres://app_user:Pg-Pass-8812@db.internal:5432/app', 'app_user:Pg-Pass-8812', 'Pg-Pass-8812');
  add('https url credentials', 'url-credentials', 'mirror at https://deploy:hunter2x@git.example.com/repo.git', 'hunter2x');
  add('redis url credentials', 'url-credentials', 'cache: redis://default:R3dis-Secret@cache:6379/0', 'R3dis-Secret');

  // Crypto keys.
  const h1 = fake.hex64();
  add('hex key after private key', 'hex-private-key', `wallet private key: ${h1}`, h1);
  const h2 = fake.hex64();
  add('0x hex key after private key', 'hex-private-key', `Private key 0x${h2} (testnet only)`, h2);
  const h3 = fake.hex64();
  add('hex key secret=', 'hex-private-key', `SIGNER_SECRET=${h3}`, h3);
  const h4 = fake.hex64();
  add('hex seed', 'hex-private-key', `seed ${h4}`, h4);
  const h5 = fake.hex64();
  add('hex key=', 'hex-private-key', `key=${h5}`, h5);
  const w1 = fakeWif(false);
  add('wif uncompressed', 'wif-key', `import ${w1} into the wallet`, w1);
  const w2 = fakeWif(true);
  add('wif compressed', 'wif-key', `wif: ${w2}`, w2);
  const m12 = fake.mnemonic(12);
  add('bip39 12 words', 'bip39-mnemonic', `backup phrase: ${m12}`, m12);
  const m24 = fake.mnemonic(24);
  add('bip39 24 words', 'bip39-mnemonic', `${m24}`, m24);
  const m15 = fake.mnemonic(15).split(' ');
  const m15a = m15.slice(0, 8).join(' ');
  const m15b = m15.slice(8).join(' ');
  add('bip39 15 words multiline', 'bip39-mnemonic', `words:\n${m15a}\n${m15b}`, m15a, m15b);
  const m12b = fake.mnemonic(12).split(' ');
  add('bip39 numbered list', 'bip39-mnemonic', m12b.map((w, i) => `${i + 1}. ${w}`).join('\n'), m12b.slice(0, 6).map((w, i) => `${i + 1}. ${w}`).join('\n'));

  // Financial and identity.
  const c1 = luhnNumber('4', 16);
  add('visa', 'credit-card', `card ${c1} exp 12/29`, c1);
  const c2 = luhnNumber('53', 16);
  add('mastercard spaced', 'credit-card', `paid with ${group4(c2)}`, group4(c2));
  const c3 = luhnNumber('37', 15);
  add('amex grouped', 'credit-card', `amex ${c3.slice(0, 4)} ${c3.slice(4, 10)} ${c3.slice(10)}`, `${c3.slice(0, 4)} ${c3.slice(4, 10)} ${c3.slice(10)}`);
  const c4 = luhnNumber('6011', 16);
  add('discover dashed', 'credit-card', `discover: ${group4(c4, '-')}`, group4(c4, '-'));
  const c5 = luhnNumber('2223', 16);
  add('mastercard 2-series', 'credit-card', `${c5}`, c5);
  add('ssn', 'us-ssn', 'SSN 123-45-6789 on file', '123-45-6789');
  add('ssn in sentence', 'us-ssn', 'her number was 532-18-7740, apparently', '532-18-7740');
  const i1 = makeIban('DE', `37040044${randomFrom('0123456789', 10)}`);
  add('iban de compact', 'iban', `transfer to ${i1} today`, i1);
  const i2 = makeIban('GB', `WEST12345698${randomFrom('0123456789', 6)}`);
  add('iban gb spaced', 'iban', `IBAN: ${group4(i2)}`, group4(i2));
  const i3 = makeIban('FR', `3000600001${randomFrom('0123456789', 11)}89`);
  add('iban fr', 'iban', `(${i3})`, i3);
  add('routing number', 'bank-routing', 'routing number: 021000021', '021000021');
  add('aba routing', 'bank-routing', 'ABA 111000025 for wires', '111000025');
  add('account number', 'bank-account', 'account number 000123456789', '000123456789');
  add('acct hash', 'bank-account', 'Acct # 4455-6677-8899', '4455-6677-8899');

  // High-entropy heuristic.
  const e1 = mixed(B64, 44);
  add('random base64 blob', 'high-entropy', `blob ${e1} end`, e1);
  const e2 = randomFrom(HEX, 48);
  add('random hex 48', 'high-entropy', `checksum-like ${e2}`, e2);
  const e3 = mixed(ALNUM, 36);
  add('random alnum 36', 'high-entropy', `session id ${e3}`, e3);
  return out;
}

export const POSITIVES: PositiveCase[] = buildPositives();

// --- Negative cases --------------------------------------------------------

export const TX_HASH = `0x${randomFrom(HEX, 64)}`;
export const EVM_ADDRESS = `0x${randomFrom('0123456789abcdefABCDEF', 40)}`;
export const GIT_SHA = randomFrom(HEX, 40);
export const ULID = '01J9Z3K4M5N6P7Q8R9S0T1V2W3';
export const NOTE_CITATION = `note:01J9Z3K4M5N6P7Q8R9S0T1V2W3@${randomFrom(HEX, 16)}`;

function buildNegatives(): NegativeCase[] {
  const n = (name: string, text: string): NegativeCase => ({ name, text });
  return [
    n('uuid v4', 'request 3f2504e0-4f89-41d3-9a0c-0305e82c3301 completed'),
    n('uuid list', 'ids: 123e4567-e89b-12d3-a456-426614174000, 9b2d1c3e-7f4a-4b8e-9c1d-2e3f4a5b6c7d'),
    n('uuid upper', 'TRACE-ID 550E8400-E29B-41D4-A716-446655440000'),
    n('git sha', `fixed in ${GIT_SHA}`),
    n('git sha in log', `commit ${randomFrom(HEX, 40)}\nAuthor: Someone <someone@example.com>`),
    n('short sha', 'cherry-picked 1a2b3c4 and 9f8e7d6'),
    n('tx hash', `swap settled in ${TX_HASH}`),
    n('tx hash list', `txs: 0x${randomFrom(HEX, 64)}, 0x${randomFrom(HEX, 64)}`),
    n('evm address', `sent 2 ETH to ${EVM_ADDRESS}`),
    n('bare sha256 checksum', `sha256 ${randomFrom(HEX, 64)}  e3d-brain-0.1.0.tgz`),
    n('ulid', `recall ${ULID}`),
    n('ulid in identifier', `journal-${ULID}-retry-attempt`),
    n('note citation', `See ${NOTE_CITATION} for details.`),
    n('commit citation', `per commit:${randomFrom(HEX, 40)}`),
    n('thesis citation', 'thesis:eth_l2_fees_fall and outcome:q3_review_2026'),
    n('prose password', 'Please reset your password using the link we sent.'),
    n('prose password is', 'The password is incorrect, try again.'),
    n('prose password manager', 'Password managers make it easy to use a unique password everywhere.'),
    n('prose password colon', 'Password: see the onboarding doc for how to request one.'),
    n('prose secret is', 'The secret to good bread is patience.'),
    n('prose token', 'Each token costs a fraction of a cent; the token is the unit of billing.'),
    n('prose token colon', 'Token: a unit of text the model reads.'),
    n('prose api key', 'API key rotation is scheduled for Friday.'),
    n('prose secret santa', 'Secret Santa signups close on Monday.'),
    n('code getToken', 'const token = getToken();'),
    n('code env', 'const apiKey = process.env.OPENAI_API_KEY;'),
    n('placeholder', 'password=<your-password-here>'),
    n('placeholder env', 'DB_PASSWORD=${DB_PASSWORD}'),
    n('masked', 'password: ********'),
    n('max tokens', 'max_tokens = 4096 and token_count: 1234'),
    n('json token_type', '{"token_type": "bearer", "expires_in": 3600}'),
    n('pwd path', 'pwd: /home/chris/projects'),
    n('lorem ipsum 1', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'),
    n('lorem ipsum 2', 'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'),
    n('lorem ipsum 3', 'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.'),
    n('long url', 'https://www.example.com/products/category/subcategory/item-name-with-many-words?utm_source=newsletter&utm_medium=email&utm_campaign=autumn_2026'),
    n('long url github', 'https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/server/index.ts#L120-L180'),
    n('long url docs', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/lastIndex'),
    n('url with user no password', 'clone ssh://git@github.com/org/repo.git'),
    n('url with port', 'http://localhost:8080/api/v1/health'),
    n('file path', '/Users/mini/e3d-brain/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js'),
    n('relative path', 'src/scrub/detectors.ts and tests/fixtures/mcp-notes/Superseded Plan.md'),
    n('kebab slug', 'release-2026-10-14-build-candidate-final-v2'),
    n('long slug', 'e3d-brain-phase-07-secret-and-sensitive-data-scrubber-notes'),
    n('camel identifier', 'ThisIsALongCamelCaseIdentifierForAClassName2'),
    n('snake identifier', 'compute_effective_tier_for_folder_class_and_status_2'),
    n('12 word sentence', 'We walked to the market and bought fresh bread for the family.'),
    n('bip39-ish sentence with stopwords', 'The army will act fast to protect the city from the storm tonight'),
    n('eleven bip39 words', 'abandon ability able about above absent absorb abstract absurd abuse access'),
    n('phone number', 'call 555-867-5309 or +1 (415) 555-0132'),
    n('dates and times', '2026-10-14T11:46:37-0700 and 2026/10/14 13:05'),
    n('version numbers', 'node 22.20.5, typescript 6.0.3, sdk 1.32.1'),
    n('luhn-invalid 16 digits', 'order 4111111111111112 shipped'),
    n('unix ms timestamp', 'ts=1760463997123'),
    n('large integer', 'population 8123456789012 (estimate)'),
    n('iban-like invalid', 'reference DE00 1234 5678 9012 3456 78'),
    n('routing without keyword', 'the batch id is 026009593'),
    n('ssn-like invalid area', 'code 000-12-3456 and 666-12-3456'),
    n('btc address', `donate to ${fakeBtcAddress()}`),
    n('bech32 address', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
    n('markdown note', '# Weekly review\n\n- [x] ship phase 6\n- [ ] start the scrubber\n\n> quote of the day'),
    n('base64 short', 'aGVsbG8gd29ybGQ='),
    n('sk slug', 'pip install sk-learn-pipelines-and-models'),
    n('redacted tokens', 'already clean: [REDACTED:openai-key] and password=[REDACTED:password-assignment]'),
    n('bearer prose', 'The bearer of this letter is a friend.'),
    n('hex color and short hex', 'colors #ff00aa #00ffcc, mask 0xff, crc 0xdeadbeef'),
    n('npm integrity-like short', 'sha1-AbCdEf0123'),
  ];
}

export const NEGATIVES: NegativeCase[] = buildNegatives();
