<p align="center">
  <img src="docs/assets/brain-spin.gif" alt="A glowing neural network in the shape of a brain, slowly rotating in 3D" width="640">
</p>

<h1 align="center">e3d-brain</h1>

<p align="center"><b>A memory that outlives the session.</b></p>

Every AI session starts blank. Claude Code forgets last week's decision. An
agent repeats the mistake it made on Tuesday. A campaign team re-discovers
what the audience already told them. The company keeps its history, but the
people and agents doing the work can't *reach* it at the moment they need it.

`e3d-brain` is a small, local-first memory server that fixes that. It sits
over a plain folder of Markdown files (an [Obsidian](https://obsidian.md)
vault), speaks MCP, and gives Claude and the E3D agents something none of
them have today: **continuity**.

> Status: the memory layer is built from
> [`docs/e3d-brain-spec.md`](docs/e3d-brain-spec.md): all 15 phases are
> implemented with 417 passing tests (verified on macOS; a Linux run is still
> pending). The cognition layer
> ([`docs/e3d-brain-cognition-spec.md`](docs/e3d-brain-cognition-spec.md)) is
> specified and being built next. The ecosystem integrations below are planned,
> not yet live. Everything below describes the intended
> system; the specs are the source of truth for what is promised.

---

## The idea

Memory is not the record. It is the *reader* of the record.

| System | What it keeps | Stays the authority for |
|---|---|---|
| **e3d-corp** | Business events: proposals, approvals, spend, outcomes | The business record |
| **e3d-pilot** | The idea ledger: specs, debates, PRs, verified results | The engineering record |
| **e3d-brain** | Notes that point back to both | *Nothing.* It helps you retrieve and interpret history |

The brain never becomes a second source of truth. Every note carries
provenance and citations pinned to a specific revision, so a claim can always
be traced to the event, commit, thesis, or outcome it came from, and checked
for staleness.

## How the E3D ecosystem uses it

Each consumer runs its own brain instance on its own vault. There is no shared
server.

| Consumer | Best use of the brain | What it contributes back |
|---|---|---|
| **You and Claude Code** | Resume work with current decisions, rationale, open questions, and rejected approaches | Proposed decisions and discoveries |
| **e3d-pilot** | Recall previous attempts, constraints, and lessons before drafting a spec | References to specs, commits, failures, and verified results |
| **e3d-corp** | Retrieve company priorities and lessons when evaluating opportunities | Evidence exports linking proposals, actions, and outcomes |
| **e3d-creative** | Retrieve audience knowledge, brand voice, previous concepts, and supported claims | Creative rationale and later campaign results |
| **e3d-agent** | Maintain continuity between runs and recall relevant experience | Its own bounded, expiring journal |
| **e3d.ai stories** | Recall prior coverage, recurring entities, and unresolved questions | Story references and corrections (fresh blockchain data is supplied separately) |

An agent can hold several brains at once: a private journal, a read-only
playbook curated by humans, and a team brain it may only *propose* into.

## What makes it safe to trust

These are enforced by tests, not promises:

- **Proposals, never silent edits.** Models can only *propose* notes into an
  inbox. A human accepts, edits, or rejects them. No MCP tool can accept,
  promote, move, or delete anything, in any mode.
- **Three modes.** `inbox` (a person's Claude proposes), `journal` (an
  autonomous agent keeps its own append-only, expiring log), `read-only`.
  Mode comes from config, never from a tool argument.
- **Memory is advisory, never authority.** Retrieved text is fenced, size-capped,
  and labeled as untrusted reference data. Memory cannot authorize spending,
  signing, publishing, or any external action.
- **Secrets never get in.** A scrubber runs before anything is written,
  indexed, or embedded. For agent principals, a write containing a private key,
  mnemonic, or API key is rejected whole.
- **Local-first.** No network by default, no telemetry, no update checks, no
  runtime installs. One module owns every filesystem path, with realpath
  containment.
- **Everything is audited.** One line per call, with who asked and which notes
  were returned; never note bodies or query text.
- **It's just Markdown.** Open any brain in Obsidian and read exactly what an
  agent has recorded. Put the vault in git for diff and rollback.

## Where it is going: cognition

A filing cabinet becomes a brain when it can notice what it holds. The
cognition spec adds owner-triggered jobs that read a brain and produce
**proposals** with citations:

- `supersede`: did a newer decision replace an older one?
- `consolidate`: which notes are duplicates of one idea?
- `forget`: what has gone stale and unused? (Archive, never delete.)
- `reflect`: what did real outcomes teach us, with citations that resolve to
  actual theses and outcomes?
- `gaps`: what do we keep asking about and know little of?

Each job reports its acceptance rate, and has written-down kill criteria. A
job nobody accepts gets turned off.

## See it

A 75-second concept video script, shot list, Higgsfield prompts, and
ElevenLabs voice direction live in [`docs/video/`](docs/video/). They have not
been rendered yet.

## Build and run

```bash
npm ci --ignore-scripts
npm run build:native      # the one documented native build (better-sqlite3)
npm test
```

See `docs/SETUP.md` (installation, MCP client snippets, running on a Linux
server). Obsidian is an optional viewer on a desktop; it is never needed on a
server. Node >= 22.

## Documents

- [`docs/e3d-brain-spec.md`](docs/e3d-brain-spec.md): the memory layer
- [`docs/e3d-brain-cognition-spec.md`](docs/e3d-brain-cognition-spec.md): the cognition layer
- [`docs/debates/`](docs/debates/): the two-model design reviews that shaped the specs
- [`docs/SECURITY.md`](docs/SECURITY.md): the invariants

The header animation is generated by [`docs/assets/render_brain.py`](docs/assets/render_brain.py) (procedural; no paid services).
