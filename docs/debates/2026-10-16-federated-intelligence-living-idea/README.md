# Federated intelligence: should it go into e3d-brain?

**Short answer:** yes, as a trimmed design note, with no build commitment and no spec change. Four models agreed on that, with one dissent about frontmatter fields.
The note is [`docs/ideas/federated-intelligence.md`](../../ideas/federated-intelligence.md). The full debate is [`transcript.md`](transcript.md).

> **Heads-up:** `transcript.md` opens with the whole source document (the first 640 lines). The debate itself starts at [Round 1](transcript.md#round-1----claude).

## What was asked

A provisional "Living Idea" from a personal Obsidian vault proposed that personal and organizational intelligence systems stay independently governed but interoperable ("federated"), with knowledge crossing boundaries only by selective, policy-governed sharing. The models were asked to pick one:

- (a) adopt it as a design requirement in the specs
- (b) include it as a design note in `docs/`, without committing to build
- (c) defer it, with a stated trigger for revisiting
- (d) do not include it

They were also asked what holds up, what it would change in e3d-brain, the risks, and what to edit in the document before including it.

## The result

**Verdict: (b), majority consensus.** Add one trimmed note at `docs/ideas/federated-intelligence.md`. Change neither spec and no frontmatter. Keep:

- "relevance does not imply disclosure"
- "share a contribution object, not vault access"
- the *private candidate that can stay private forever*, which maps onto cognition's propose-then-accept loop
- the open questions

Cut the product-vision sections and the links that don't resolve outside the vault. Rename the domain-level "origin" to `source_domain` and "authority" to `standing`. Add non-goals, a threat model (leaks through summaries, logs and embeddings), and a statement that metadata is not authorization.

**Revisit when** a second real vault needs an owner-run, one-way publish, which the cognition spec already records as **G19** and marks as needing its own security review.

## Who said what

| Model | Round 1 | Round 2 |
| --- | --- | --- |
| Claude | (c) defer with a trigger, but proposed writing the same note | Switched to (b); adopted Grok's trigger; rebutted its own earlier "reserve optional keys" idea |
| Codex | (b), plus a draft contribution-proposal schema | (b); noted Claude's (c) was the same file under another label |
| Grok | (b), grounded in the real specs | (b); rejected any spec change before G19's security review |
| Devin | (b), but add `origin`, `relevant_to`, `visibility`, `authority` to the spec now | Conceded the field collision; still wants optional fields after an audit |

## The dissent

- **Devin** would add optional domain-provenance and epistemic-status fields to the spec after a collision audit.
- **Grok and Codex** would change nothing until G19 gets its own security review.

Why adding the fields now was rejected (this came from Grok, the only model that read the specs): `origin` already means `mcp|hook|import|cli` in the provenance model; `authority` contradicts "memory is advisory, never authority"; the cognition spec's C4 forbids storing relevance scores as facts; and a `visibility` label that nothing enforces looks like a security guarantee and would be trusted.

## Moments worth reading

- **Claude rebutting itself.** Each model sees the others' answers labelled by name, so in round 2 Claude read its own round-1 answer as someone else's and argued against it: [round 2](transcript.md#round-2----claude).
- **Devin's catch nobody else made:** the document's example contribution object says `provenance: preserved`, which is circular and says nothing about how provenance survives transformation; and "policy" appears 11 times without a mechanical definition: [round 2](transcript.md#round-2----devin).
- **Grok reading the repo first.** Only Grok went and found the real e3d-brain specs before answering. The others answered from the project description, and two of them proposed fields that would have collided with existing ones: [Grok, round 1](transcript.md#round-1----grok-build).
- **The verdict:** [synthesis](transcript.md#synthesis-claude).

## How it was run, and what to keep in mind

- Four models (`claude`, `codex`, `grok-build`, `devin`), two rounds, up to 450 words each; Claude wrote the synthesis.
- The debate was run from the e3d-pilot checkout, not from this repo, so only Grok had the specs in front of it. A better setup is to run it from inside this repo, or to paste the relevant spec excerpts into the question.
- This summary was written by an AI from the transcript. Where it matters, check the source text.

Ledger: idea `idea-a35c837feb28`; the verdict is event `evt-100046206e7e9e54b6ffe03d`.
