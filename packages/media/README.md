# `@after-genesis/media` — the media service (§4G, §21)

Turns stored canonical dialogue and derived captions into audio. It is
**read-only with respect to the world**: nothing here can propose, validate or
commit a canonical write (§15 — "Media services cannot mutate world state").

## Where the API key lives, and why there is no runtime call

The spectator app is a static export with no server (`next.config.mjs`,
`output: "export"`), because §17 requires the public client to have no canonical
write path and §28 requires no human-facing write route to exist at all.

That decision also settles how audio works:

- there is **no route handler** that could proxy an ElevenLabs request;
- a client-side call would ship `ELEVENLABS_API_KEY` to every spectator.

So audio is rendered **ahead of time**, offline, on a machine holding the key,
and published as ordinary static files. The browser only ever fetches an `.mp3`
and a manifest. `read-only.test.ts` enforces this: the app's single permitted
`fetch` is asserted to be a same-origin GET with no options object.

## Canonical handles vs. provider voice ids

Canonical state stores a **handle** — `voice_f04` — assigned at creation and
never changed (§21 "persistent voice configuration"). This package maps handles
to provider voice ids from configuration.

The indirection is not decoration. An ElevenLabs id is vendor configuration: it
can be retired, or replaced when the account or provider changes. Writing one
into canonical state would mean a vendor's decision forces a rewrite of every
birth record — a constitutional change (§23) that would break replay, because
reconstructed checksums would stop matching production (§15, §28).

`packages/core/src/engine/voice.ts` owns the handles; nothing in `packages/core`
knows ElevenLabs exists.

## Configuration

Every key must be **unique**. A repeated key is not a list — every loader keeps
only the last assignment. Pools are comma-separated, and pool position N is
canonical handle N, so entries must never be reordered or removed once a world
is live. Appending is safe.

```
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_NARRATION=
ELEVENLABS_VOICES_MALE=      # exactly VOICES_PER_SEX ids, comma-separated
ELEVENLABS_VOICES_FEMALE=    # exactly VOICES_PER_SEX ids, comma-separated
ELEVENLABS_VOICE_CHILD_MALE=
ELEVENLABS_VOICE_CHILD_FEMALE=
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
MEDIA_CHILD_MATURITY_BELOW=3
```

`buildVoiceRegistry` throws on a wrong-sized pool, a duplicate id or a missing
narration voice. It never falls back: a silent fallback is how a voice layer
looks like it works while rendering every inhabitant identically.

Child voices are not separate canonical handles. Maturity changes over a life;
a handle must not. The renderer uses the child voice of the inhabitant's sex
while canonical `maturity` is below the threshold, then the assigned adult
voice — a presentation decision read from canonical state, like gait or camera
framing.

## Rendering

From `apps/spectator`:

```bash
npm run voice:plan                        # dry run: what would be said, and the cost
npm run voice:render                      # render every reel
npm run voice:render -- --reel=physical   # one reel
npm run voice:render -- --limit=20        # cap new syntheses (a spend guard, §15)
```

Output goes to `apps/spectator/public/voice/<reel>/`: content-addressed clips
plus a `manifest.json` keyed by chronicle segment id. Re-running is cheap —
identical text in the same voice resolves to the same file, so only genuinely
new lines are billed.

A line that fails is recorded in the manifest's `skipped` map and the pass
continues (§21 — "A failed audio job must never block or change the
simulation").

## What is voiced, and what is not

`apps/spectator/src/lib/cinema/voice-lines.ts` decides, and both the renderer
and the player call it, so they cannot disagree about what exists.

- **Dialogue**, in an inhabitant's own voice, only where a segment is
  `disclosed`, its action is a speech action, and it has exactly one speaking
  participant. That is a canonical record of that inhabitant saying something.
- **Narration**, in the narrator's voice, for the segment's neutral caption.
  A caption is derived text, so putting it in an inhabitant's voice would be
  inventing a quotation.
- **Nothing at all** for withheld contents, unrecorded gaps, or a
  multi-participant conversation whose envelope does not say who said what.
  §11G leaves interpretation to inhabitants; the renderer does not guess.

If a segment has no rendered clip, the player says so and stays silent. It has
no speech-synthesis fallback, deliberately: audio that did not come from the
configured provider must never be presented as though it did.
