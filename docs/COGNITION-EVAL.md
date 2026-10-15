# Cognition evaluation and kill criteria

Every cognition job costs review time (and, for model-backed jobs, compute).
A job earns its place only if the owner accepts enough of what it proposes.
This document states how that is measured and when a job should be turned
off. The numbers below are the ones `ebrain cognition report --check`
enforces (`KILL_CRITERIA` in `src/cognition/report.ts`; a test keeps the two
equal).

## What is measured

`ebrain cognition report` counts, per job and job version, from review
records only (never from model output):

- **created**: proposals listed in run records (`<stateDir>/runs/`). Dry runs
  and shadow runs create none.
- **accepted**: applied with `ebrain review accept`, unedited
  (`_inbox/_applied/`).
- **edited then accepted**: applied after `ebrain review edit` (the proposal
  carries an `edited` stamp).
- **rejected**: `ebrain review reject` (`_inbox/_rejected/`), with the
  `--reason` text tallied (whitespace collapsed, lowercased).
- **stale**: refused at accept because a target changed (`status: stale`).
- **pending**: still `proposed` in `_inbox/` (including undone ones).
- **missing**: recorded, but the proposal file is gone.
- **median time to review**: proposal `created` to its `applied` or
  `rejected` stamp, over reviewed proposals.

**Acceptance rate** = (accepted + edited then accepted) / reviewed, where
reviewed = accepted + edited then accepted + rejected. Stale, pending, and
missing proposals are not part of the rate. It is the primary signal that a
job is worth its cost.

## Kill criteria

A job is **below threshold** when, for its current job version, the
acceptance rate over its last `window` reviewed proposals (newest review
first) is below `minimum acceptance`, and at least `minimum reviewed`
proposals have been reviewed. With fewer reviews there is no verdict yet.

| Job | Minimum acceptance | Window (last reviewed) | Minimum reviewed | Why this bar |
|---|---|---|---|---|
| `supersede` | 30% | 50 | 10 | Each proposal names two notes and verbatim quotes; below 30% the owner is mostly confirming that pairs are compatible. |
| `consolidate` | 30% | 50 | 10 | Merges and summaries are cheap to judge but noisy duplicates waste attention. |
| `reflect` | 25% | 50 | 10 | Lessons are advisory and harder to judge; a slightly lower bar, but a model run per thesis is the most expensive job. |
| `forget` | 30% | 50 | 10 | Demote/archive proposals are quick to review; repeated rejections mean the age/recall windows are wrong for this brain. |
| `gaps` | 20% | 50 | 10 | Accepting a gap report only files it; a low bar, but a gap list nobody files is noise. |
| `selftest` | (not checked) | | | Exercises the pipeline; not a judgment. |

`ebrain cognition report --check` prints each job's verdict (`ok`, `not enough
reviews yet`, or `BELOW THRESHOLD: disable this job`) and exits **3** when any
job is below its threshold (1 on errors, 2 on usage errors, 0 otherwise), so a
cron line can alert:

```cron
0 9 * * *  EBRAIN_CONFIG=$HOME/.config/e3d-brain/config.json ebrain cognition report --check > /dev/null || echo "cognition job below threshold" | mail -s ebrain "$USER"
```

**What to do when a job is below threshold:** stop scheduling it (remove the
cron line or launchd plist). Before re-enabling, look at the rejection
reasons in the report, adjust the job's thresholds (`cognition.<job>.*` in
the config) or wait for a new job version, and evaluate the change without
creating review work: run it with `--shadow` for a while, or replay it
against history (below). A new job version starts a fresh window.

## Shadow and replay evaluation

- **Shadow mode** (`ebrain cognition run <job> --shadow`) writes proposals to
  `<stateDir>/shadow/<run-id>/` instead of `_inbox/`. `cognition report`
  shows, per job and version, how many shadow proposals the owner later
  carried out by hand.
- **Replay** (`ebrain eval replay --job <job> --at <commit-or-date>`, vault in
  git with a clean history) runs the job on the vault as of that commit in a
  temporary copy and reports precision (proposals matching a later owner
  action) and recall (later actions of the kinds the job proposes that it
  proposed). Without a usable git history it exits 1 with a message that
  only online metrics are available.

Matching is structural and best effort, never by text:

| Proposal | Counts as done when |
|---|---|
| sets `status: superseded` on a note | that note is now `superseded` |
| archives or moves a note (`archive`, `merge`) | that note is now `archived` or under `_archive/` |
| sets `status: stale` (`demote`) | that note is now `stale` or archived |
| creates a `lesson` | a new `kind: lesson` note cites at least one of the proposal's evidence ids in `derived_from`/`sources` |
| creates a `summary` | a new `kind: summary` note cites at least two of them (all, if fewer) |
| `gap` | never (it changes nothing) |

Later actions counted toward each job's recall: `supersede` superseded;
`consolidate` merged (archived with `merged_into`) and new summaries;
`reflect` new lessons; `forget` demoted and archived; `selftest` demoted;
`gaps` none.

Replay caveats: notes need assigned ids at the replayed commit (C3); the
recall history copied into the replay is only what `recalls.jsonl` still
holds (`recallLog.retentionDays`); evidence files are today's, not
historical; and a model-backed job replayed with a different model or prompt
version measures that model, not the one that ran back then.
