# Federated intelligence (design note)

> **Status: idea, not a commitment.** This note changes neither spec, adds no
> frontmatter fields, and builds nothing. It records a direction worth keeping
> and the one concrete slice e3d-brain already has for it (G19).
> **Revisit when** a second real vault needs an owner-run, one-way publish.

## Why this note exists

A person's private memory and a team's shared memory should stay separate, yet
a lesson learned in one is sometimes worth offering to the other. e3d-brain's
v1 isolation answers the first half (separate instance, separate vault, no
cross-principal flow). This note keeps the framing for the second half so it is
not reinvented later.

It is adapted from a provisional "living idea" written on 2026-09-25 in Joel's
personal vault, after a four-model debate on whether and how to include it
(`docs/debates/2026-10-16-federated-intelligence-living-idea/`). Most of the
mechanisms it touches (access control, multi-tenancy, capability-style sharing,
approval workflows) are established work in new vocabulary. What is useful here
is applying them to *model-maintained Markdown memory*.

## The five ideas worth keeping

1. **Independent but interoperable.** Each principal keeps a sovereign brain.
   Several brains cooperate; they are not merged into one universal brain.
2. **Relevance does not imply disclosure.** Noticing that a private note
   matters to a group is a different act from sharing it.
3. **Share a contribution, not vault access.** Anything that crosses a boundary
   is a bounded, reviewable object, never a mounted vault or a bulk copy.
4. **Keep four questions separate:** where did it come from, who might it
   matter to, who may read it, and how far should it be trusted.
5. **A private candidate may stay private forever.** The owner's side can
   detect "this would help the team" and hold a draft contribution without
   anything leaving the vault.

## The part that fits e3d-brain

Idea 5 maps directly onto cognition's propose-then-accept loop. Cognition
already notices things and proposes changes for a human to accept. A
*contribution candidate* is one more kind of proposal: it is written to the
owner's own `_inbox/`, a human decides, and nothing is published autonomously.
The brain does not need to know anything about the destination to do this.

## The four questions, under names that do not collide

| Question | In the original idea | In this note | e3d-brain today |
| --- | --- | --- | --- |
| Where did it come from? | origin | `source_domain` | `origin` is already provenance (`mcp`, `hook`, `import`, `cli`); do not reuse the name. |
| Who might it matter to? | relevance | (not stored) | C4: no scores stored as facts. A proposal may say so in prose; no `relevant_to` field. |
| Who may read it? | visibility | (not a field) | Vault + instance + write mode (`inbox`, `journal`, `read-only`). There are no per-note ACLs. |
| How far to trust it? | authority | `standing` | "Memory is advisory, never authority." Standing is `status` plus `kind`, never permission. |

None of these are fields in the spec, and this note does not add them. A
`visibility` label that nothing enforces looks like a security guarantee and
would be trusted. If a field is ever added, it needs enforcement first.

## The smallest future slice already exists: G19

The cognition spec records **G19**, an owner-run, one-way `publish` that copies
one note into another brain's `_inbox/` with re-scrubbing and provenance, and
lists it as out of scope pending its own security review. That is the
contribution object. Anything proposed in this note should be built as G19,
not as a parallel design. The revisit trigger is therefore concrete: a second
real vault that needs it, and then the security review first.

## Non-goals

- No multi-tenant server, shared vault, or cross-brain querying.
- No identity, ACLs, or policy engine.
- No autonomous publishing, and no auto-approval of contributions.
- No stored relevance scores, and no new authority paths from memory.
- No group "Operating System", knowledge-base platform, or product vision.

## Threat model (sketch)

- **Leaks are not only copied text.** Summaries, proposals, metadata, search
  results, logs, and embeddings can all carry private content across a boundary.
- **Two brains in one context.** An agent that can read both a private and a
  shared brain can mix them in its own output. The leak path is the agent, not
  the Markdown file.
- **Metadata is not authorization.** A note labeled "shareable" is still just a
  note; enforcement lives in modes, instances, and the human review gate.
- **Sanitization is unproven.** Re-scrubbing catches known secret shapes, not
  meaning.
- **Revocation cannot unlearn.** A copy that was read or accepted cannot be
  taken back from a person or a model.

## Open questions

Tagged by what answers them. `[brain]` can be decided inside one instance,
`[governance]` needs organization-level policy or identity that e3d-brain does
not have, `[research]` is unsolved in general.

- How should private contribution candidates be surfaced to their owner? `[brain]`
- How should provenance survive transformation (scrub, summarize, re-file)? `[brain]`
- How should one event be captured once and projected into several contexts? `[brain]`
- How should retraction work after something was shared? `[brain]` `[governance]`
- Which contribution types, if any, may ever skip human acceptance? `[governance]`
- How are conflicting contributions, ownership, departures, and former-member
  access handled? `[governance]`
- What is canonical at group level versus personal level, and how is consensus
  told apart from one person's opinion? `[governance]`
- Can a shared system detect convergence without exposing the private evidence? `[research]`
- What governance is needed before personal agents negotiate or act across
  boundaries? `[governance]`

## Provenance of this note

Adapted from the 2026-09-25 living idea; scope, cuts, and renames follow the
majority verdict of the 2026-10-16 debate. Dissent worth remembering: one
participant would add optional provenance and standing fields to the spec after
a collision audit; two would change nothing until G19's security review.
