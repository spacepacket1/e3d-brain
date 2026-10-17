# M1 audit: evidence inventory for the adversarial reviewer RFC

`m1-audit.mjs` answers the RFC's M1 question, "how much usable evidence do our debate logs hold?", before anyone
trains anything. It is read-only: it scans repo checkouts and writes only into `--out`.

```bash
node examples/reviewer-audit/m1-audit.mjs --root ~ --out ./m1-audit-out
```

It reads, per repo: `docs/debates/*/transcript.md`, `.e3d-pilot/runs/*/negotiation-log.md` and `.e3d-pilot/events.jsonl`.
Byte-identical clones are counted once; lineage families come from the git remote.

Outputs: `report.md`, `inventory.json`, `missing-links.json`, and `sample-cases.json` (a few redacted candidate records in
the RFC 5.2 shape, with every unknown left `unknown`).

## What it reports

- Linkage coverage for each reviewer objection (a turn with status `revise`): spec text before and after the round,
  link to an idea, idea implemented or merged, outcome with verification.
- The committee's kill criterion: fewer than 30 distinct revised rounds means capture data prospectively before any
  training. Revision links only; validity is not labelled.
- Rights: turns per model provider, with `training permission: unknown` unless you pass `--permissions`.
- Counts of secret-shaped strings and email addresses found (values are never stored).

## Read the numbers carefully

A `revise` verdict in a negotiation ships a replacement spec, so "the spec changed" is expected by construction. It
shows a revision happened, not that the objection was valid or caused the change. Validity, severity and uniqueness
need adjudication (M2). Debates argue questions, not spec drafts, so debate objections have no before/after spec.
Missing links are unknown, not evidence of no effect. Parsers match the log formats written today; if pilot changes
them, update the parsers and the fixture in `tests/reviewer-audit.test.ts`.

Nothing here authorizes training on any log. Rights and provider terms have not been reviewed.
