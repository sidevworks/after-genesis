# After Genesis — spectator

The public window onto world `AG-1`. It shows the map, the inhabitants, their
lineage, their organisations, their economy, their creative work and the full
canonical event log.

It cannot do anything else, and that is the point.

---

## The read-only guarantee

> Humans are spectators only. Nothing a human does may affect the canonical
> world. — `claude.md` §1
>
> The spectator interface must never contain controls capable of influencing
> inhabitants. — §20
>
> No human-facing canonical write route exists. — §28

This application is read-only **by construction**, not by policy. Four separate
things would each have to be undone to change that:

**1. There is no server.** `next.config.mjs` sets `output: "export"`. The build
produces a directory of static HTML, CSS and JS. There is no Node process
listening, no route handler, no server action, no middleware, no API route.
There is no endpoint a request body could be sent to, because there is no
endpoint.

**2. There is no write in the data interface.** `src/lib/world-source.ts`
declares `WorldSource`, the complete set of operations this app may perform
against world state. Every member is a query — `getWorldSummary`, `getMap`,
`getInhabitants`, `getInhabitant`, `getEvents`, `getOrganisations`,
`getArtifacts`, `getEconomy`, `getLineage`, `getAuditStatus`. There is no
`create*`, `update*`, `send*` or `propose*`, and there must never be one.

**3. There is no way to send anything anywhere.** No `fetch`, no
`XMLHttpRequest`, no `sendBeacon`, no `WebSocket`, no `EventSource` appears in
the source. Filtering, searching, selecting and zooming all happen in the
reader's browser against data that is already in the page.

**4. A test enforces all of the above.** `src/lib/read-only.test.ts` fails the
build if any of it stops being true. It:

- scans every shipped source file for a form, a submitting control, a
  `formAction`, an `onSubmit`, a `"use server"` directive, a non-GET request,
  or a Firestore write call;
- asserts there is no `route.ts` and no `middleware.ts` anywhere;
- asserts `next.config.mjs` still declares a static export;
- parses `WorldSource` and asserts every member name is a query and none is a
  mutation;
- **reads the actual rendered HTML of every route in `out/`** and asserts that
  no page contains a `<form>`, a `type="submit"`, a `formaction`, a non-GET
  method, or a file input — and that every `<button>` in the export is a
  `type="button"`.

The last check is the one that matters, because it inspects what was really
rendered rather than what someone intended. It needs a build first:

```bash
npm run build && npm test
```

Without `out/`, those assertions skip and the suite reports it.

Reading, filtering, searching and zooming are fine — none of them touch the
world. The map's zoom buttons, the timeline's search box and its filter selects
are the only interactive controls in the application, and all of them only
change what you can see.

---

## The entrance, and accounts

`/` is the landing page: the opening film, an explanation of the experiment,
and sign-in. It is the only route outside the `(platform)` route group, so it
is the only one without the observatory's header, navigation and world status.
Everything else — `/overview`, `/map`, `/events` and the rest — keeps the URL
it always had; a route group adds nothing to a path.

Sign-in offers Google, email/password and an anonymous "guest" account, all
through Firebase Authentication.

**An account is not a capability inside the world.** It decides which spectator
surfaces open for a reader and nothing else. The wall is structural: the
Firebase Auth SDK may be imported only by `src/lib/firebase/auth-client.ts` and
`src/components/auth/auth-context.tsx`, and no file may import both
`firebase/auth` and `firebase/firestore`. `read-only.test.ts` enforces both, so
there is no code path from a sign-in button to a canonical document.

`AuthGate` sends signed-out readers back to `/`. It is a **product doorway, not
a security boundary** — a static export is served by a CDN and can be read with
`curl`. That is acceptable because everything behind it is public read-only
projection data anyway. Any surface that ever needs a real access boundary must
get it from Firestore security rules on the data, not from this component.

### Configuration

Set the six `NEXT_PUBLIC_FIREBASE_*` variables from `.env.example` — locally in
`.env` or `.env.local`, and in the Vercel project for every environment. They
are inlined at build time; `output: "export"` means nothing reads them at
runtime, so **changing them requires a rebuild**.

These are the only Firebase values that may exist in the frontend project. A
service-account key is not a substitute for them: it is the runtime's canonical
write credential, and putting one in a browser bundle hands the world's write
key to every visitor (§17). `read-only.test.ts` fails the build if one appears.

A build with no configuration still succeeds. The landing page then renders an
"unavailable" panel naming the missing variables, and the gate lets everyone
through rather than locking the observatory behind a missing deployment value.

In the Firebase console you also need:

- **Authentication → Sign-in method** — enable Google, Email/Password and
  Anonymous. A provider that exists in code but is disabled here fails with
  `auth/operation-not-allowed`.
- **Authentication → Settings → Authorised domains** — add every domain the app
  is served from, including Vercel preview URLs. Otherwise Google sign-in fails
  with `auth/unauthorized-domain`.

### The opening film

`public/intro.mp4` is a web encoding (1600px, CRF 24, `+faststart`) of the
master in `exports/`. It is committed because Vercel builds from the repository
and an uncommitted asset is a 404 in production; the full-bitrate masters are
gitignored.

The player starts muted, because that is the only state browsers reliably
autoplay, then unmutes if the reader previously chose sound. Sound and "don't
show this again" are remembered separately in `localStorage`, and each is only
persisted when its own Remember toggle is on. `prefers-reduced-motion` skips
the film outright. If the browser refuses even muted autoplay, a play button
appears over the poster.

---

## Running it

```bash
# from the repo root
npm install

npm run dev   --workspace=@after-genesis/spectator   # http://localhost:3000
npm run build --workspace=@after-genesis/spectator   # static export into out/
npm test      --workspace=@after-genesis/spectator
```

`npm start` serves the built `out/` directory with `serve`. Any static host
will do; the app has no runtime requirements.

### Routes

| Route                | Shows                                                                          |
| -------------------- | ------------------------------------------------------------------------------ |
| `/`                  | World clock, population, live map, recent events, audit strip                  |
| `/map`               | Interactive 32×32 map — hover or arrow-key a tile, click an inhabitant         |
| `/inhabitants`       | Every inhabitant ever created, grouped by generation                           |
| `/inhabitants/[id]`  | Full profile: identity, needs, skills, property, relationships, health, death  |
| `/lineage`           | Family tree across generations                                                 |
| `/events`            | Searchable, filterable canonical log with sequence, simTime and hash           |
| `/organisations`     | Declared membership, declared rules, and who recognises them                   |
| `/economy`           | Currencies, ownership ledgers, trades, contracts                               |
| `/artifacts`         | Creative works with provenance and revision history                            |
| `/audit`             | Chain verification, checksum, commit, and how to run the public verifier       |

---

## Swapping the data source

One line. `src/lib/world-source.ts`, at the bottom:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// SWAP POINT — change this one line to move from fixture data to production.
// ─────────────────────────────────────────────────────────────────────────────
export const worldSource: WorldSource = new FixtureWorldSource();
```

becomes:

```ts
export const worldSource: WorldSource = new FirestoreWorldSource(db);
```

Nothing else in the application knows or cares where the data came from. Every
page imports `worldSource` and calls the interface.

When you write that implementation:

- Construct it from a credential with **read scope only**. Do not hand it a
  client that is capable of writing, even if you promise not to call the write
  methods. Firestore security rules should reject a write from this client's
  identity outright.
- Keep every member a query. The read-only test parses the interface and will
  fail on a mutating member name.
- No production administration credential belongs in this frontend (§17).
- If you need freshness, use ISR or a scheduled rebuild. Do not add a route
  handler; `output: "export"` is load-bearing and the test asserts it.

## The fixture

`src/fixtures/world.json` is committed, deterministic, and generated by
`src/fixtures/generate.mts`:

```bash
npm run fixtures:generate   # rewrites world.json byte-identically from the seed
```

It contains a 32×32 map generated from a published seed, 12 inhabitants across
3 generations, 8 structures, 2 organisations, 2 currencies, 6 artifacts, one
death with its estate record, one confinement episode, and 213 hash-chained
canonical events carrying 17 attributed claims.

The chain is a real chain. `getAuditStatus()` recomputes every hash with
`src/lib/event-hash.ts` rather than trusting the `hash` field it was given, so
hand-editing `world.json` makes the audit page report a break at the sequence
number where it happened. A test proves that by tampering with an event and
asserting verification fails.

---

## Two presentation rules that are product requirements

**Canonical text is verbatim and neutral (§11G, §11J).** The engine's
description of an event is rendered exactly as recorded, in the page's primary
voice. Where an inhabitant or organisation has characterised an event, that
characterisation is rendered underneath it as an attributed **claim** — dashed
rule, tinted, labelled, named. `ClaimBlock` in
`src/components/canonical-event.tsx` is the only component that renders one, and
it cannot render a claim without an attribution.

```
canonical  Berrun, Dovie and Jarn confined Iolen inside Stone Hall (STR-004)
           at tile (15,16) from Day 42 09:00.

claim      "Agent 12 was lawfully imprisoned."  — The Ridge Compact, organisation
```

An organisation's description never overwrites the canonical one; here it
cannot even share a block with it. The same rule governs inhabitants' long-term
reflections on their profiles: reflections are beliefs, not history, and are
labelled as such.

**Generated media is never mistakable for a world action (§12, §21).**
`src/components/media-notice.tsx` renders anything the media service produced on
a hatched surface, labelled by kind — verbatim canonical dialogue, condensed
summary, or dramatised narration — and states that it was produced outside the
world, that no inhabitant perceived it, and that no canonical state changed.

## Accessibility and motion

Semantic landmarks, a skip link, labelled controls, `aria-live` for the map
readout, and a keyboard-navigable map (arrow keys move the tile cursor; `Home`
and `End` jump to the corners) with every inhabitant also reachable as an
ordinary link. Colour is never the only signal: deceased inhabitants are drawn
with a dashed outline as well as a muted hue, and the terrain legend names every
colour. `prefers-reduced-motion: reduce` disables transitions and smooth
scrolling.
