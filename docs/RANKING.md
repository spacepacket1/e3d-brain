# Ranking

Invariant I13: the final order of every retrieval result list is computed in
one module, `src/index/rank.ts`. No other module reorders results; a scan
test (`tests/rank.test.ts`) fails if another module sorts results or orders
SQL by relevance. Later phases add fixtures that produce notes of each tier,
not new ordering code.

## Tier table

Highest first. "Registered" is the phase whose end-to-end fixtures first
produce notes of that tier; Phase 4 implements and tests the whole function.

| Tier | Contents | Registered |
|---|---|---|
| T1 curated | folder class `curated` and `reference`, status `accepted` (or absent), including accepted lessons | Phase 4 |
| T2 inbox | folder class `inbox`, status `proposed` | Phase 8 |
| T3 cited journal lesson | journal, `kind: lesson`, at least one well-formed citation in `sources` | Phase 9 |
| T4 uncited journal lesson | journal, `kind: lesson`, no well-formed citation | Phase 9 |
| T5 other journal | other `journal` entries | Phase 9 |
| T6 raw | folder class `raw` (`_raw/`) | Phase 10 |
| T7 stale | status `stale`, in any folder class (ordered after T6) | Phase 4 |
| T8 unknown | unknown `status` value | Phase 4 |

The status column is descriptive. The normative rule is the function below.

T6 holds the raw archive (`_raw/`): conversation transcripts written by
`ebrain import claude-code|claude-export|chatgpt-export` (Phase 10) with
`kind: raw`. They are searchable but rank below every curated, inbox, and
journal note; results carry the label `raw-archive` and the list header a
notice that they record what was said, not established facts.

## `effectiveTier(folder_class, status)`

A total function, evaluated in this order:

1. Status `rejected`, `superseded`, or `archived`, or folder class `archive`,
   or a hidden folder (`_inbox/_rejected/`, `_inbox/_applied/`): **hidden by
   default** (not in the table). Everything under `_archive/` and
   `journal/_archive/` has folder class `archive`.
2. Unknown status (any value outside `proposed`, `accepted`, `rejected`,
   `journal`, `superseded`, `archived`, `stale`, compared exactly, or a
   non-string value the index marked `status_known = 0`): **T8**.
3. Status `stale`: **T7**.
4. Otherwise by folder class: `curated` and `reference` T1, `inbox` T2,
   `journal` T3 to T5 (by `kind` and `sources`), `raw` T6.

An absent status skips steps 1 to 3. A note moved out of `_inbox/` by hand is
`curated` and therefore T1 whatever its `status` says (including
`proposed`); a note inside `_inbox/` is T2 even if it claims `accepted`.
A "well-formed citation" (T3, Phase 9) is a `sources` entry of kind
`thesis`, `outcome`, `commit`, or `note` that the Phase 3 citation grammar
accepts (`parseCitation`); a `url:` or `ref:` source records provenance but
does not ground a lesson. Resolution against external evidence is not
checked. Journal entries in every tier are labeled `agent-journal` in
results (and `untrusted_origin` where the entry says so).

Hidden notes are dropped from results. Filters in Phase 6 reveal them; when
revealed they are placed after T8.

## Ordering rules

Results are compared by, in order:

1. **Source:** vault notes first, then reference books (`scope: refs`, Phase
   11). Under `scope: all` books always come after every note tier. Books are
   ordered among themselves by the same rules (they rank as `reference`).
2. **Tier:** T1 first, T8 last, revealed hidden notes after T8.
3. **Relevance:** the FTS5 `bm25()` value (lower is more relevant), rounded
   to 1e-6 before comparison (I11), so float noise never decides an order.
   When Phase 12 is on, the vector rank is fused here via RRF. Listings
   without a query have no relevance and fall through to the next rule.
4. **Path:** bytewise on the NFC form of the vault path, then bytewise on the
   raw name (the listing order of Phase 2, `comparePaths`).
5. **Ordinal:** the chunk ordinal within the note.

Reference books (Phase 11) are not vault notes and carry no status: every
book passage ranks as tier T1 `reference` among books (`tierOf` with source
`ref`), ordered by relevance and then by `<ref_id>/<chapter>` and the chunk
ordinal. `search` returns at most `refs.maxHits` of them, after the notes.

`journal_list` (Phase 9) passes `newestFirst`: after rule 3, entries with a
later `created` come first (absent or unparseable `created` last), then rules
4 and 5. Every other tool uses the rules above unchanged.

The result is fully deterministic: the same vault, config, and query give the
same order on every platform.
