# E3D evidence export (stub)

This file describes what an E3D exporter must produce for `ebrain evidence
import` (see `docs/SETUP.md`, "Evidence files"). The exporter itself lives
in the E3D repositories and is **out of scope for e3d-brain**: e3d-brain never
contacts E3D services, so evidence arrives only as a local file.

## Output

One UTF-8 JSONL file, one record per line, at most `evidence.maxRecordBytes`
(default 8192) bytes per line and `evidence.maxFileMB` (default 64) per file.
Use a `.jsonl` name such as `e3d-<agent>-<yyyymmdd>.jsonl`.

```json
{"kind":"thesis","id":"th_123","occurred":"2026-09-01T00:00:00Z","summary":"short text","attributes":{"agent":"0x...","status":"closed"}}
{"kind":"outcome","id":"oc_456","occurred":"2026-09-20T00:00:00Z","summary":"short text","attributes":{"thesis":"th_123","result":"win","metric":"+4.2%"}}
```

Only these five top-level keys are accepted. Unknown keys make the line invalid (it is skipped and counted).

## Thesis records (`kind: "thesis"`)

| Field | Source in E3D | Notes |
|---|---|---|
| `id` | thesis id, prefixed `th_` | `[A-Za-z0-9_]+`, at most 128 characters; stable across exports |
| `occurred` | when the thesis was created | ISO 8601 UTC with `Z` |
| `summary` | the thesis statement, shortened | at most 1000 characters; no secrets, keys, or wallet seeds |
| `attributes.agent` | agent address or id | string |
| `attributes.status` | `open`, `closed`, `invalidated`, ... | string |
| `attributes.token` | token symbol or address, if any | optional string |

## Outcome records (`kind: "outcome"`)

| Field | Source in E3D | Notes |
|---|---|---|
| `id` | outcome id, prefixed `oc_` | as above |
| `occurred` | when the outcome was measured or the position closed | ISO 8601 UTC with `Z` |
| `summary` | one-line description of what happened | at most 1000 characters |
| `attributes.thesis` | the thesis `id` this outcome resolves | string; lets `reflect` pair them |
| `attributes.result` | `win`, `loss`, `flat`, `invalidated` | string |
| `attributes.metric` | the measured result, e.g. `+4.2%` | string (keep units in the text) |

## Rules

- Attribute keys are identifiers (`[A-Za-z_][A-Za-z0-9_]{0,63}`). Values are strings, numbers, booleans, null,
  arrays, or objects nested at most two levels below `attributes`, with at most 256 values in total.
- Re-exporting is safe: a later record with the same `kind` and `id` replaces the earlier one.
- Do not include private keys, API keys, or seed phrases. Records are scrubbed on import anyway, and on agent
  brains a record containing a credential is dropped.
- Records are cited as `thesis:<id>` and `outcome:<id>`. Keep ids stable, or old citations stop resolving.
