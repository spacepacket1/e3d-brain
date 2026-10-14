# e3d-brain concept video (75 seconds, 16:9)

Status: **script and production package only. Nothing here has been rendered.**
Higgsfield and ElevenLabs are not configured on the machine that wrote this.

Rules for the cut (keep it honest):
- Show the system as a *vision*, labeled "concept". Do not show fake terminal
  output or invented metrics as if real.
- No real wallet addresses, keys, or customer data on screen.
- The on-screen text may only claim what the spec promises.

## Narration (about 170 words, 75 s at a calm, confident pace)

> Every AI session begins the same way. Blank.
>
> Yesterday's decision, gone. The approach you already rejected, proposed
> again. The lesson an agent learned the hard way, learned again.
>
> The company remembers. The tools don't.
>
> Meet e3d-brain. A memory that lives in plain Markdown, in your own vault.
> No cloud. No telemetry. Just notes you can read.
>
> Claude picks up where you left off, with the decision and the reasoning
> behind it. Pilot checks what was already tried before it writes a spec.
> Corp weighs a new opportunity against what past outcomes actually taught.
> Creative remembers the audience, the voice, and the claims that held up.
> Agents wake up knowing who they were yesterday.
>
> And nothing becomes memory without a human saying yes.
>
> Every idea cites its source. Every lesson is grounded in a real outcome.
> Memory advises. It never decides.
>
> e3d-brain. Your ecosystem, with a past.

## Shot list

| # | Time | Visual | On-screen text |
|---|---|---|---|
| 1 | 0-6 s | A single cursor blinking in an empty chat window; the window resets, again and again | "Blank." |
| 2 | 6-14 s | Sticky notes dissolving into static; a rejected sketch reappearing on a whiteboard | "Same mistakes. Again." |
| 3 | 14-20 s | A vast glowing archive seen through glass; small figures on the other side who can't reach it | "The company remembers. The tools don't." |
| 4 | 20-28 s | A folder of Markdown files unfolds into a luminous constellation of linked notes | "e3d-brain" |
| 5 | 28-44 s | Five quick vignettes, one per tool (Claude Code, Pilot, Corp, Creative, Agent), each reaching into the constellation and pulling out one lit note | tool name per vignette |
| 6 | 44-54 s | A hand approves a glowing proposal; it settles into the constellation as a permanent star | "Nothing becomes memory without a yes." |
| 7 | 54-64 s | A note's thread traced back to a commit, an outcome, a decision, each point labeled with its source | "Every note cites its source." |
| 8 | 64-75 s | Pull back: the constellation holds the whole ecosystem; logo resolves | "e3d-brain. Your ecosystem, with a past." |

## Higgsfield prompts

Generate each shot as a 5 to 8 second clip. Use the same style block for
consistency, and fix a seed per shot where the tool allows it.

**Style block (append to every prompt):**
`cinematic, deep navy and warm amber palette, soft volumetric light, shallow
depth of field, slow dolly camera, photoreal with subtle abstraction, no text,
no logos, no real faces`

1. `A lone blinking cursor in an empty chat window on a dark desk; the window
   flickers and resets to blank, three times. Camera pushes in slowly.`
2. `Paper sticky notes drifting apart into digital static; a rejected pencil
   sketch reappears on a whiteboard as if for the first time. Quiet, uneasy mood.`
3. `Through a glass wall, an enormous softly glowing archive of floating
   documents; on the near side, small silhouettes reaching toward the glass,
   unable to touch it.`
4. `A folder opens and plain text pages lift out, linking to one another with
   thin amber threads until they form a luminous constellation in dark space.`
5a. `A developer's hand at a keyboard; a single lit note rises out of a
    constellation and settles beside the code on screen.`
5b. `A robotic arm pausing over a blueprint as a glowing note slides in with a
    prior attempt marked in red.` 
5c. `A boardroom table of holographic charts; one lit note labeled by past
    outcomes reorders the charts.`
5d. `A designer's moodboard assembling itself around a single recalled phrase.`
5e. `A small autonomous drone waking on a charging pad, a journal page
    unfolding in the air before it.`
6. `A hand presses an approve gesture on a floating card; the card dissolves
   into light and becomes a permanent star in the constellation.`
7. `A thread of light traced from a glowing note back through three labeled
   waypoints: a code commit, a chart outcome, a decision card.`
8. `Slow pull-back from the constellation as it expands to hold a whole city of
   interconnected systems at night; fade to dark navy.`

Add all on-screen text in the edit (not in the generated video), so it stays
legible and correct.

## ElevenLabs voice direction

- **Voice:** calm, warm, assured; mid-range; no announcer cadence. Pick a
  stock voice described as "documentary, intelligent, warm".
- **Pace:** about 2.3 words per second. Leave a beat after "Blank." and after
  "The company remembers. The tools don't."
- **Settings starting point:** stability around 0.5, similarity high,
  style low (0.1 to 0.2), speaker boost on. Generate two or three takes and
  choose by ear.
- **Pronunciation:** "e3d" as "E three D"; "Pilot", "Corp", "Creative" as
  ordinary words.
- **Music:** a sparse ambient bed that swells at shot 4 and again at shot 8,
  ducked under the narration. Any generated or licensed track.

## Assembly checklist

1. Render the eight shots (and the five 5a to 5e vignettes) in Higgsfield.
2. Generate the narration in ElevenLabs; time it against the shot list.
3. Cut in any editor; add the on-screen text and a "concept" tag in a corner.
4. Review every frame for accidental text, faces, or logos before publishing.
