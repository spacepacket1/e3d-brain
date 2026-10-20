# AI memory has a ceiling. Here's what we built above it.

*Draft for a long-form post. Every command and output below was run on a real
vault; nothing is mocked.*

---

AI tools remember more than they used to. Preferences, project facts, the way
you like your code formatted. Ask the same assistant the same kind of question
twice and it often already knows.

But that memory has a ceiling, and you hit it the moment the work gets serious.

**It is partial.** It keeps *what* you decided and loses *why*, what you
rejected, and what is still open. The reasoning is the part you need in six
months.

**It is siloed.** It lives inside one vendor's product. Move to another machine,
another model, or hand the work from a person to an agent, and you start again.

**It is opaque.** You can't open it and read it. You can't tell which entry is
stale, or where a claim came from.

And there is a slower failure underneath all three. A few months in, one note
says *we use MySQL* and a newer one says *we moved to Postgres*. Nothing marks
which still stands. The assistant picks one, with complete confidence.

There are plenty of simple tricks for this: a notes file, an index file, a rules
file the assistant reads at startup. They are good, and they work for a while.
What none of them can do is notice that your own records now disagree.

That is the problem I built **e3d-brain** for.

## The idea

Two rules hold it together.

1. **Memory is advisory, never authority.** It retrieves and interprets
   history, with citations. It can't approve, spend, sign, or publish anything.
2. **Models propose; humans decide.** Nothing becomes permanent memory, and no
   existing note changes, until a person says yes. Every change can be undone.

It is a small local server over a plain folder of Markdown files, the kind
Obsidian opens. It speaks MCP, so any client that can launch an MCP server can
use it. The notes stay yours, readable, and diffable in git.

On top of that sits a second layer I call cognition: a set of jobs you run that
look after the memory and write *proposals* for you to review.

| Job | Asks | Proposes |
|---|---|---|
| `supersede` | Did a newer decision replace an older one? | Mark the old note superseded, citing both |
| `consolidate` | Which notes are duplicates? | Merge, or a cited summary |
| `reflect` | What did real outcomes teach us? | Lessons that must cite real records |
| `forget` | What has gone stale and unused? | Demote or archive. Never delete |
| `gaps` | What do we keep asking about and know little of? | A gap report |

## Watch it catch a contradiction

Here is a tiny vault. Two decisions about the same service, three months apart:

```
notes/database-choice-mysql.md     occurred: 2026-02-10   "We are using MySQL for the orders service."
notes/database-choice-postgres.md  occurred: 2026-05-14   "We are moving the orders service to Postgres. MySQL no longer fits."
```

Ask it which database the orders service uses and the search returns the
**MySQL** note first. The stale one wins. That's the failure.

Now run the job:

```
$ ebrain cognition run supersede
proposals: 1 created, 0 already in _inbox/, 0 previously rejected (skipped), 0 invalid
supersede: 1 candidate pairs from 3 notes
no LLM provider: proposals are marked needs_review: unadjudicated
```

It found the pair without calling any model. It did not change anything. It
wrote a proposal. Look at exactly what accepting it would do:

```
$ ebrain review diff 01M5CR3VPRH84G7ARTNJ6YDYVQ
edit notes/database-choice-mysql.md
+ status: superseded
+ superseded_by: 01M5CR3V8GBR2ED65SJ1GN26Q1
+ superseded_at: 2026-05-14
+ valid_until: 2026-05-14

edit notes/database-choice-postgres.md
+ supersedes:
+   - 01M5CR3V8A928DEH9GXXJVFV78
```

That is the whole change: four lines on the old note, two on the new one. You
read it, and you decide.

```
$ ebrain review accept 01M5CR3VPRH84G7ARTNJ6YDYVQ
applied
undo with: ebrain review undo 01M5CR3VPRH84G7ARTNJ6YDYVQ
```

Ask again, and the answer is now Postgres. The MySQL note is hidden from search
by default, and still there if you ask what we believed *as of* February.

I then pointed a different vendor's client at the same vault: OpenAI's Codex
CLI, launching the same server over stdio. It answered *Postgres*, cited the
note id, and reported the note's status as `accepted`. No Claude involved. The
memory is the vault, not the client.

## How you know it's working

A memory layer that rewrites your notes has to earn its place. So each job
reports its **acceptance rate**: of the proposals it made, how many you actually
accepted. The kill criteria are written down before any data exists. For
example, a job whose acceptance rate falls below 30% over its last 50 reviewed
proposals should be switched off, and one command checks it:

```
ebrain cognition report --check     # exits non-zero when a job should go
```

Jobs can also run in `--shadow` mode, or be replayed against your own git
history, so you can judge them before they create any review work.

## What keeps it safe to trust

- Nothing leaves your machine by default. No telemetry, no update checks.
- Secrets are scrubbed before anything is written, indexed, or embedded.
- Retrieved text is fenced and labeled as untrusted, so a note can't instruct the
  model that reads it.
- Every call is audited, without note bodies or query text.
- It is plain files. Open the vault and read exactly what an agent recorded.

## Try it

```bash
npm install -g e3d-brain
ebrain init --vault ~/Brain --principal you
ebrain doctor --strict
```

Add the snippet `init` prints to your MCP client. Write two notes that disagree,
then:

```bash
ebrain ids assign
ebrain cognition run supersede
ebrain review list
```

## Where it stands

This is early, and I'd rather say so than have you find out.

- It has 675 passing tests, and has been run on macOS and Linux (arm64).
- It was written by AI and checked by tests and by independent model reviews. It
  has **not** had a human security audit.
- The cognition jobs are built to be measured, but they haven't run long enough
  on real data to say they earn their keep. The acceptance rates will tell us.
- Not yet tried on x64 or Windows.

The code, the specs, and the design debates that shaped them are in the repo:
https://github.com/spacepacket1/e3d-brain
