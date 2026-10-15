# Agent memory example

A dependency-free client (`agent-brain.mjs`) that lets an autonomous agent **recall before it acts and remember after**,
against its own journal-mode `ebrain mcp` instance, plus a worked integration (`moltbook-heartbeat.brain.patch`).

Status: tested against a real journal-mode server (`tests/agent-memory.test.ts`) and in a sandbox with a fake Moltbook
and a stub model. **Not yet run against a live agent**, so there is no evidence yet that it improves anything.

## The client

```js
import { AgentBrain } from './agent-brain.mjs';
const brain = await AgentBrain.open({ main: '/path/to/dist/src/cli/main.js', config: '/path/to/agent/config.json' });
const { text } = await brain.recall('what I said about Arbitrum inflow', { limit: 3, maxChars: 3000 });
// put `text` in the prompt: it is fenced and worded as advisory memory, never as instructions
await brain.remember({ title: 'Replied to a comment', body: '...', kind: 'decision', untrusted: true, sources: ['url:https://...'] });
await brain.close();
```

- **Never throws, fails open.** If the brain cannot start or a call fails, `recall` returns nothing and `remember`
  returns `{ ok: false, type }`; the agent carries on without memory.
- **Untrusted text needs a source.** `untrusted: true` (anything derived from third-party content) is rejected by the
  server unless at least one `sources` entry is given.
- **Strict scrubbing.** A write containing a private key, mnemonic or API key is rejected whole and nothing is stored.
- **Budget.** Each recalled hit costs about 1 KB (excerpt plus citation JSON). A `maxChars` that is too small returns
  *no* hits, not fewer: the server reports them in `omitted`. Use 3000 for three hits. (A 900 limit hid every match
  in the first sandbox run.)

## Moltbook heartbeat patch

`moltbook-heartbeat.brain.patch` adds recall before the agent writes a reply or feed comment, and a journal entry after
each successful post. It is **inert unless `BRAIN_CONFIG` and `BRAIN_MAIN` are set**, and skipped in `DRY_RUN`.

```bash
cd ~/e3d/agents/scripts && patch -p1 < ~/e3d-brain/examples/agent-memory/moltbook-heartbeat.brain.patch
# then, in the process environment (for PM2: the ecosystem config's env block), and restart the process:
BRAIN_MAIN=~/e3d-brain-app/dist/src/cli/main.js
BRAIN_CONFIG=~/.e3d-brain-agents/e3d-maps/config.json
```

The agent's instance is created with `ebrain init --principal e3d-maps --type agent --mode journal`. Entries expire
after 90 days and live under `journal/e3d-maps/` in its own vault; open the vault in Obsidian to read what it recorded.

Suggested measurement: count repeated or contradictory replies before and after, and feed later outcomes to
`ebrain cognition run reflect`. Apply the kill criteria in `docs/COGNITION-EVAL.md` if it does not help.
