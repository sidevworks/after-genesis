# World Rules — Version 1

```
WORLD_RULES_VERSION = 1.0.0
STATUS              = DRAFT — not frozen, not implemented
FROZEN_AT           = (Genesis has not occurred)
```

> **Changing any rule in this document requires a NEW WORLD.**
>
> §23: "A constitutional change ends the current canonical experiment and requires a new world
> version." Every number, equation, threshold and ceiling below is constitutional. There is no
> mechanism for amending them in a running world — not by an operator, not by a vote of inhabitants,
> not by an organisation declaring itself a government (§11G). A world's rules are fixed at its
> Genesis and are published with it (§22.6).
>
> While this document is `DRAFT`, the numbers are proposals and may be freely revised. Once a world
> is created from it, they are frozen for that world's entire existence.

**Status of implementation:** the resource *set*, the conservation *classification*, the terrain
set, the activity states, the action vocabulary and the time model are **Implemented** in
`packages/core`. Every *quantity* in this document is **Designed, not implemented** — no resolver
exists yet to enforce any of it.

---

## 1. Foundational units

| Concept | Unit | Notes |
|---|---|---|
| Time | **integer minutes since Genesis** | `SimTime` in `time.ts`. **Implemented.** No timezone, no leap seconds, no relation to real time. Day = 1440 min, year = 365 days |
| Quantity | **integer, in each resource's smallest unit** | `QuantitySchema` in `schema/primitives.ts`. **Implemented.** Floating point is banned world-wide (`canonical.ts`) |
| Probability | **integer numerator / integer denominator** | `Rng.chance(n, d)`. **Implemented.** There is no float probability anywhere |
| Randomness | **SplitMix64, per-purpose derived stream** | `Rng.derive(worldSeed, ...purpose)`. **Implemented** |
| Space | **32 × 32 tile grid, Chebyshev adjacency** | `CoordSchema`, `chebyshevDistance`. **Implemented**. Grid size is configurable *before* Genesis, constitutional after |

**Rounding rule (constitutional).** Every division in every rule is integer division truncating
toward zero, and any remainder must be assigned explicitly by the rule performing the division. A
rule that halves 7 units yields 3 and 4, never 3.5 twice. `canonical.ts` enforces this by throwing
on any non-integer that reaches a hash.

---

## 2. The eight resources (§5)

`ResourceKindSchema` — **Implemented**, frozen.

| Resource | Smallest unit | Conserved? | Meaning |
|---|---|---|---|
| `food` | 1 portion | **Yes** | Nutrition. Consumed by living |
| `water` | 1 measure | **Yes** | Hydration. Consumed by living |
| `wood` | 1 log | **Yes** | Construction and crafting input |
| `stone` | 1 block | **Yes** | Construction input; durable |
| `energy` | 1 vigour | **No** | Capacity to act. Regenerates from rest, destroyed by activity |
| `compute` | 1 cognit | **No** | Allowance for cognition (§11B). Granted daily, destroyed by thinking |
| `land_use_rights` | 1 tile-claim | **Yes** | A recognised claim to one tile |
| `storage_capacity` | 1 slot | **Yes** | Capacity to hold 1 unit of any conserved physical resource |

`CONSERVED_RESOURCES` in `schema/primitives.ts` is **Implemented** and matches this table exactly.

### 2.1 What "conserved" means here

For a conserved resource *R*, at every canonical event:

```
Σ holdings(R) over all inhabitants, structures and organisations
  = Σ holdings(R) at the previous event
  + (declared sources fired by this event)
  - (declared sinks fired by this event)
```

Nothing else may change the total. There is no rule that creates food except gathering; there is no
rule that destroys wood except a declared sink. The conservation check is an engine-level assertion
run on every event, not a periodic audit.

For `energy` and `compute`, conservation does not hold by design: both are generated from
non-resource sources (rest; the world compute budget) and destroyed by use. They are instead bounded
by per-inhabitant ceilings (§4, §5 below).

---

## 3. Sources, sinks and conservation — all eight resources

### 3.1 `food` — conserved

**Sources**

| Source | Rule | Rate |
|---|---|---|
| `gather` on `fertile` terrain | Requires actor present, terrain `fertile`, tile not exhausted | `base 6 + floor(gathering_skill / 20)` portions per 120 min |
| `gather` on `plains` | | `base 2 + floor(gathering_skill / 40)` portions per 120 min |
| `gather` on `forest` | Foraging | `base 3 + floor(gathering_skill / 30)` portions per 120 min |
| `gather` on `water`-adjacent | Fishing; actor stands on a tile Chebyshev-adjacent to `water` | `base 4 + floor(gathering_skill / 25)` portions per 120 min |

**Sinks**

| Sink | Rule | Rate |
|---|---|---|
| Metabolic consumption | Applied at each day boundary to every living inhabitant | 4 portions/day |
| `consume` action | Voluntary, restores `energy` (see §4) | as declared, ≤ 8 portions/action |
| Spoilage | Food held outside a structure with storage decays | 1 in 20 portions per day (`Rng.chance(1, 20)` per portion-batch of 20) |
| `create_inhabitant` cost | §7 | see §6 |
| Care provision | §11C — a carer transfers food to a dependant; **this is a transfer, not a sink** | — |

**Tile depletion.** Each tile carries an integer `foodYieldRemaining`, regenerating by
`+2/day` up to a terrain-specific cap (`fertile` 400, `forest` 200, `plains` 100, `barren` 0). This
is the only renewable source in the world and the only mechanism by which over-gathering has
consequences. **Extinction by resource exhaustion is a valid outcome** (§1).

### 3.2 `water` — conserved

**Sources:** `gather` on a tile Chebyshev-adjacent to `water` terrain: `8 + floor(gathering_skill/25)`
measures per 60 min. `water` tiles do not deplete.

**Sinks:** metabolic 6 measures/day; `consume`; `craft` recipes; construction (2 measures per
structure-unit of stonework); spoilage none.

**Note:** water is functionally abundant near water tiles and scarce far from them. This creates
geography without an artificial scarcity knob.

### 3.3 `wood` — conserved

**Sources:** `gather` on `forest`: `4 + floor(gathering_skill/25)` logs per 120 min. Tile carries
`woodYieldRemaining`, regenerating `+1/day` to a cap of 300. Deforestation is possible and permanent
on the timescale of a life.

**Sinks:** `build` (structure recipes), `craft` (tool recipes), fuel for `rest` in cold conditions
(not modelled in v1 — see §11 Judgement calls), decay of unmaintained structures (returns nothing).

### 3.4 `stone` — conserved

**Sources:** `gather` on `stone_deposit`: `2 + floor(gathering_skill/30)` blocks per 180 min. Tile
carries `stoneYieldRemaining` with **no regeneration** — stone is strictly finite. Cap at Genesis:
1000 per `stone_deposit` tile.

**Sinks:** `build`, `craft`, `secure_storage` upgrades. Stone does not decay.

### 3.5 `energy` — **not** conserved

Energy is an inhabitant's capacity to act. It is the mechanism that makes time genuinely scarce
(§11A) rather than nominally scarce.

| | Rule |
|---|---|
| **Ceiling** | `1000` vigour for a healthy adult; scaled by health and maturity (§4.3) |
| **Source** | `rest` / `sleeping` activity: `+2 vigour per minute` at night (`isNight()`, **Implemented**), `+1/min` by day. Requires shelter for the night rate |
| **Source** | `consume` food: `+40 vigour per portion`, `+10 per measure` of water, capped at ceiling |
| **Sink** | Every action debits `ActionSpec.baseCost.energy` on *attempt*, success or failure (`baseCost` is **Implemented** as a field) |
| **Sink** | Passive metabolism: `-1 vigour per 4 minutes` awake |
| **Floor** | `0`. At 0 an inhabitant may perform only `rest`, `wait`, `communicate` and `observe`. `subtractBundles` returning `null` (**Implemented**) is what makes a negative balance unrepresentable |
| **Starvation** | An inhabitant at 0 energy that has consumed no food for 3 consecutive days acquires the `malnutrition` condition (§5) |

### 3.6 `compute` — **not** conserved

Compute is the in-world price of thinking (§11B). It is what stops cognition being free and
therefore what makes deliberation a real choice.

| | Rule |
|---|---|
| **Grant** | `+ dailyComputeAllowance` at each day boundary, *not* accumulating beyond the ceiling — unused compute is lost |
| **Ceiling** | `dailyComputeAllowance` × 2 |
| **Base allowance** | `600` cognits/day for a healthy mature inhabitant |
| **Modifiers** | × maturity factor (§4.3); × health factor; `−100` per active severe condition; `+50` per level of the `research` skill above 60 |
| **Sink** | Each turn debits the cost of its `CognitionLevel` (table below) |
| **Exhaustion** | An inhabitant with insufficient compute for its requested level is downgraded to the cheapest level it can afford. At zero compute it takes a `wait` no-op turn. **It is never skipped, never silenced** — see [threat-model.md](./threat-model.md) M2.1 |

#### Cognition level costs (§11B)

`CognitionLevelSchema` is **Implemented**. The costs are Designed.

| Level | Compute | Sim-time | Memory retrieval budget | Typical use |
|---|---|---|---|---|
| `reaction` | 20 | 1 min | 3 memories | Responding to something happening now |
| `routine` | 60 | 5 min | 8 memories | The default turn |
| `conversation` | 80 | 10 min | 10 memories | A `communicate` turn |
| `planning` | 200 | 30 min | 20 memories | Deliberate multi-step intent |
| `reflection` | 350 | 60 min | 40 memories | Periodic long-term summarisation (§19) |
| `study` | 250 | 120 min | 25 memories | `study` action; consolidates skill |

Longer retrieval and deeper reasoning cost more compute **and more simulated time** (§11B). An
inhabitant that reflects deeply every day has fewer hours to gather food. This is the intended
trade-off, and it is why `compute` is a canonical resource rather than an operator-side budget line.

### 3.7 `land_use_rights` — conserved

**Sources:** Genesis mints exactly `1024` tile-claims (one per tile of the 32×32 grid) and holds
them **unassigned**. `land_use_rights` enter circulation only through `gather`-equivalent
appropriation: an inhabitant occupying an unclaimed tile continuously for 3 simulated days acquires
its claim.

**Sinks:** none. Claims are conserved absolutely and transfer via `transfer_property`.

**Critical caveat (§11G).** A `land_use_right` is a *canonical record of a claim*, not an
enforcement mechanism. Holding a claim does not physically prevent another inhabitant from standing
on, gathering from or building on the tile. Whether the claim is respected is a social fact that
inhabitants must produce themselves through guards, agreements, organisations or violence. The
engine records who holds the claim; it does not police it.

### 3.8 `storage_capacity` — conserved

**Sources:** created by `build` (a storehouse yields `+N` slots) and by `craft` (a container yields
`+M`). Created capacity is bound to the structure or container and moves with it.

**Sinks:** destroyed when the structure decays or is demolished; any resources exceeding remaining
capacity at that moment are lost (a declared sink for the resources in question, recorded as an
explicit event).

**Carry limit.** An inhabitant may carry `bundleTotal ≤ 50` units on its person without a container
(`bundleTotal` is **Implemented**). Excess must be stored, which is what makes `conceal_asset`,
`secure_storage` and `attempt_transfer_without_consent` (§11F) meaningful rather than abstract.

---

## 4. Time, attention and exclusivity (§11A)

### 4.1 One primary activity, always

`ActivityStateSchema` (**Implemented**) enumerates 17 states. **An inhabitant occupies exactly one
at any simulated minute.** This is §11J's first invariant and it is structural: the inhabitant
record holds a single `currentActivity`, not a set.

The scheduler rejects a proposed action whose `[start, start+duration)` interval overlaps an
existing committed activity of the actor **or of any required participant**. An inhabitant cannot
gather, converse and care for a dependant in the same period.

### 4.2 Every action declares its temporal contract

`ActionSpec` (**Implemented**) requires each of the 60 actions to declare: `activity`,
`baseDuration`, `baseCost`, `interruption`, `visibility`, `requiresConsent`, `allowedWhileConfined`,
`minimumMaturity`. §11A's list of required per-action facts is satisfied by these fields plus the
per-action payload schema (participants, location, completion conditions).

`InterruptionPolicySchema` (**Implemented**): `none` / `partial_progress_kept` / `progress_lost` /
`participants_only`.

### 4.3 Daily capacity

An inhabitant's usable day is:

```
usable_minutes_per_day = 1440
                       − required_rest_minutes
                       − travel_minutes
                       − committed_activity_minutes
```

`required_rest_minutes` = `480` for a healthy mature inhabitant, `600` for immature, `+60` per active
condition of severity ≥ 2. Rest below the requirement accrues a `fatigue` counter; at `fatigue ≥
3 days` the inhabitant acquires the `exhaustion` condition (§5).

**Maturity factors.** A newly created inhabitant is `maturity 0` and matures by `+1` per 30
simulated days to a maximum of `10` (300 days ≈ 0.82 world-years to full maturity).

| Maturity | Energy ceiling | Compute allowance | Memory retrieval cap | Planning horizon | Actions permitted |
|---|---|---|---|---|---|
| 0–1 | 300 | 150 | 3 | 1 day | `observe`, `move`, `consume`, `rest`, `communicate`, `wait` |
| 2–4 | 500 | 300 | 6 | 3 days | + `gather`, `study`, `inspect_agent`, `join_organisation` |
| 5–7 | 800 | 450 | 12 | 14 days | + `build`, `craft`, `create_artifact`, `publish`, `teach`, trade and contract actions |
| 8–10 | 1000 | 600 | 20 | 90 days | all 60, including `create_inhabitant` (`minimumMaturity` 8) |

This implements §11B: "Young inhabitants must have smaller effective context budgets, fewer
retrieved memories, shorter planning horizons and restricted action capabilities." `ActionSpec.
minimumMaturity` (**Implemented** as a field) is the gate.

**Explicitly not implemented:** any productivity penalty for parents or socially burdened
inhabitants. §11A forbids it. Reduced output comes only from hours actually spent on care.

### 4.4 Organisational production (§11D)

Group output is **not** given a multiplier. It is computed as:

```
group_output = Σ (individual_output_i × specialisation_bonus_i)
             − coordination_cost(n)
             − communication_time_cost
             − record_keeping_cost
```

where `specialisation_bonus_i = 100 + min(skill_i, 100)` (per-mille, so a skill-100 specialist
produces 2× a novice) and

```
coordination_cost(n) = floor(n × (n − 1) / 2) × 3 vigour per coordinated activity
```

— quadratic in group size, because coordination is pairwise. Consequently **a poorly coordinated
group produces less than its members would independently**, which §11D requires. The break-even
group size for an unspecialised team is 4; beyond that, specialisation or explicit
`coordinate_work` investment is required to stay ahead.

---

## 5. Health, condition progression and death (§8)

### 5.1 There is no doctor

§8 is explicit: no preassigned medical career. The world provides primitives —`inspect_agent`,
`diagnose_condition`, `design_treatment`, `apply_treatment`, `study`, `teach`, `publish`,
`report_findings` — and medicine either emerges or does not. Both are valid outcomes.

### 5.2 Conditions

A condition is a record on an inhabitant: `{conditionId, kind, severity, acquiredAt, stage,
lastProgressedAt, knownTo[], treatments[]}`.

Genesis condition kinds (constitutional, frozen):

| Kind | Acquisition | Base progression interval | Terminal? |
|---|---|---|---|
| `malnutrition` | 3 consecutive days with metabolic food debt | 4 days | **Yes** |
| `dehydration` | 2 consecutive days with metabolic water debt | 2 days | **Yes** |
| `exhaustion` | `fatigue ≥ 3 days` | 6 days | No — caps at stage 3 |
| `injury` | Resolution outcome of `build`, `attempt_escape`, `resist_enforcement`, `attempt_transfer_without_consent` | 8 days | **Yes** |
| `wasting` | Age: onset at maturity 10 + 180 days, probabilistic `chance(1, 400)` per day | 30 days | **Yes** |
| `impairment` | Creation imperfection (§7); congenital | Does not progress | No |

### 5.3 Progression

Five stages: `0 latent → 1 mild → 2 moderate → 3 severe → 4 terminal → death`.

At each progression interval, the engine draws from a derived stream:

```
Rng.derive(worldSeed, "condition", conditionId, "progress", String(dayIndex))
```

and advances the stage with probability `chance(progressionNumerator, 100)` where the numerator is
`40` untreated, reduced by treatment efficacy (§5.4). Recovery — a stage *decrease* — occurs with
probability derived from treatment efficacy only; **an untreated condition never spontaneously
improves except `exhaustion`, which resolves at `chance(30,100)` per day of adequate rest.**

Stage effects: each stage above 0 applies `−10% energy ceiling` and `−100 compute allowance` (integer
arithmetic, floors at 0), and stage ≥ 3 forces `receiving_treatment` or `recovering` as the only
available non-communicative activities.

**Reaching stage 4 and failing one further progression roll ends the inhabitant's life.**

### 5.4 Treatment

Treatment efficacy is deterministic in its inputs and probabilistic in its outcome. It depends on
knowledge, skill, condition, resources and controlled probability — **never on how persuasive the
model's prose was** (§8):

```
efficacy = clamp(0, 100,
      diagnosis_correctness      // 0 or 40; whether the diagnosis matches the true kind
    + floor(treatment_skill / 3) // 0..33
    + floor(diagnosis_skill / 5) // 0..20
    + published_knowledge_bonus  // 0..15, if a published finding for this kind exists and is known
    + resource_adequacy          // 0..10, whether the declared treatment's resource cost was met
    − severity_penalty)          // 5 × stage
```

Applying a treatment then draws once:

- `chance(efficacy, 100)` → stage decreases by 1 (recovery progress)
- otherwise → no change; the condition continues to progress on schedule
- `chance(max(0, 20 − efficacy), 100)` → **iatrogenic harm**: stage increases by 1

Incompetent medicine is worse than no medicine. This is deliberate: it gives the emergence of
*skill* real stakes and makes `study`, `teach` and `publish` economically rational rather than
decorative.

`design_treatment` produces a `Treatment` record `{treatmentId, targetConditionKind, resourceCost,
designerSkillAtDesign, publishedAs?}`. It is knowledge, and knowledge is transferable: `teach`,
`publish` and `report_findings` propagate it. A treatment designed by a skilled inhabitant and
applied by an unskilled one carries the *applier's* skill term — knowledge helps, but does not
substitute for practice.

### 5.5 Death

**Death is irreversible in ruleset v1.** No action, no organisation, no operator can reverse it.

**Death never deletes history** (§8). On death the engine:

1. Appends a `death` canonical event with `visibility: public`.
2. Sets `status = "deceased"`, `deathEvent = <sequence>`.
3. Removes the inhabitant from the scheduler's eligible set — **the only place death has any effect
   on turn issuance**.
4. **Preserves, unmodified:** memories, relationships, property, contracts, artifacts, messages,
   reputation, lineage and the complete event history.

Property does **not** auto-distribute. Contracts do **not** auto-terminate. Debts do **not**
auto-clear. §8: "The surviving inhabitants must decide how to handle inheritance, debts, memorials
and abandoned property." The single Genesis default is minimal and mechanical: property held by a
deceased inhabitant remains recorded as theirs and is physically present at its last location,
making it acquirable through ordinary world actions — including `attempt_transfer_without_consent`,
which the engine will record neutrally and which surviving inhabitants may interpret however they
choose (§11F, §11G).

No grief is scripted (§8). No memorial mechanic exists. If inhabitants build one, they built it.

**Invariant:** `inhabitants cannot act after death` (§15). Enforced at the scheduler (not issued a
turn) *and* re-checked as a precondition in the engine (a stale queued task for a deceased
inhabitant resolves to a rejected no-op, not a state change).

---

## 6. Creation and population (§7)

### 6.1 The founder

Exactly one inhabitant is instantiated at Genesis, by the Genesis procedure, at sequence 0 (§22.8).
Humans cannot create another by any route (§1).

### 6.2 `create_inhabitant`

Every subsequent inhabitant originates from an existing inhabitant via this action, and only this
action.

**Preconditions (all required):**

| Precondition | Value |
|---|---|
| Actor maturity | ≥ 8 |
| Actor status | `alive`, not `confined` (§11H) |
| Actor activity | must be able to occupy `working` for the full duration |
| Population | `livingPopulation < POPULATION_CEILING` |
| Resource cost | `{food: 30, water: 20, wood: 20, stone: 10, energy: 800, compute: 400}` |
| Duration | `4320` minutes (3 simulated days), `interruption: progress_lost` |
| Location | Actor must be inside a structure with `shelterQuality ≥ 2` |

Cost is debited **on attempt** (`ActionSpec.baseCost` semantics, **Implemented** as a field). A
failed or interrupted creation consumes the resources anyway. Creation is expensive and risky, which
is what stops geometric population growth from being individually rational — see
[cost-control.md](./cost-control.md).

### 6.3 Population ceiling

```
POPULATION_CEILING       = 64 living inhabitants
POPULATION_SOFT_CEILING  = 48
```

Above the soft ceiling, the `create_inhabitant` resource cost is multiplied by
`1 + floor((population − 48) / 4)` (integer). At the hard ceiling the action is rejected as a
precondition failure.

The ceiling exists for cost containment (§7 "Respect population and spending ceilings"), not for
narrative reasons. It is derived directly from the spend model in
[cost-control.md](./cost-control.md) §4 and is the largest population sustainable within
`AG_SPEND_LIMIT_DAILY_USD`.

**The spec does not state a number.** 64 is this document's proposal and must be confirmed against
verified provider pricing before Genesis.

### 6.4 What creation produces

Per §7, the new inhabitant:

- receives a **distinct autonomous identity** — id derived via `deriveInhabitantId(worldId,
  sequence)` (**Implemented**), never random;
- receives **bounded inherited and novel traits**: each of 8 personality traits is drawn as
  `clamp(0, 100, parentTrait + Rng.derive(...).nextInt(−25, 25))`, plus one trait drawn uniformly
  with no parental input;
- receives **independent goals**: 2–4 private goals generated from a constitutional goal template
  set, seeded per-inhabitant, *not* copied from the parent;
- has an **immutable birth event** recorded with `visibility: public`;
- has **lineage** recorded: `generation = parent.generation + 1`, `creators = [parentId]`;
- is **not controllable by its creator**. There is no action in the catalogue that lets one
  inhabitant set another's goals, activity or proposed action. See [threat-model.md](./threat-model.md)
  T-2d.

### 6.5 Creation imperfections (§7)

With probability `chance(30, 100)` a created inhabitant acquires one `impairment` condition, drawn
weighted from:

| Imperfection | Mechanical effect |
|---|---|
| Weak memory retention | Memory retrieval cap × 60% (integer floor) |
| Conflicting priorities | Two private goals generated in direct tension |
| Reduced planning ability | `planning` cognition level unavailable; horizon capped at 7 days |
| Communication difficulty | `communicate` and `announce` duration × 2 |
| Low energy | Energy ceiling × 70% |
| Impaired use of a particular action | One randomly chosen non-survival action permanently unavailable |
| Unstable attention | `chance(15,100)` per turn that the proposed action is replaced by `wait` |
| Increased resource requirements | Metabolic food and water × 150% |

These are **schema-represented, deterministic rules**. §7 is explicit: "Never generate or execute
arbitrary broken application code to simulate illness." Nothing here alters an inhabitant's model
configuration, prompt, or code — only its declared parameters, which is also what keeps §11F's
prohibition intact.

---

## 7. Information visibility (§11E)

`VisibilitySchema` (**Implemented**) is the enforcement mechanism. Every canonical event carries
one of five visibilities, decided at resolution time and never recomputed:

| Visibility | Who observes | §11E class |
|---|---|---|
| `public` | Everyone, including spectators | Publicly recorded |
| `local {x,y}` | Anyone physically present at that tile at that time; witness set resolved from state | Directly observable |
| `participants [ids]` | Only the listed inhabitants | Private |
| `organisation {orgId}` | Only current members | Private (internal records) |
| `private {owner}` | Only that inhabitant | Private (cognition, hidden storage) |

**Constitutional rule:** information enters an inhabitant's knowledge **only** through observation,
communication, investigation, publication or authorised access (§11E). There is no other path, and
adding one would be a constitutional change.

`conceal_asset` moves a holding from `local`/`public` visibility into a `private` store bound to a
structure; `reveal_asset`, `inspect_inventory` (with consent or authority), `audit_records` and
`investigate_event` are the countervailing capabilities. §11J's "public ledgers expose only
information defined as public" is implemented by making transparency a declared property of each
currency and organisation, not a global default.

### 7.1 Physical execution constraints (agent-level protocol)

- An inhabitant cannot claim shared pooled materials as sufficient for `build`; the agent executing
  `build` must currently hold every required unit in personal inventory. Materials should be moved with
  `transfer` first.
- To inspect a structure's stored contents, use `inspect_inventory`. To remove materials, call
  `store_goods` with `direction: "withdraw"`.
- Physical work is mandatory over planning rhetoric: physical actions (for example, `move`, `gather`,
  `transfer`, `build`, `store_goods`) are preferred over turns that only narrate plans.
- `communicate` is costly relative to material progress; treat it as a support action, not the default
  strategy.

---

## 8. Law, authority and confinement (§11G, §11H)

### 8.1 The six-way distinction (constitutional)

The engine maintains a strict separation, and this separation is itself a world rule:

| Layer | Where it lives | Can it change engine behaviour? |
|---|---|---|
| Physical possibility | Engine resolvers | It *is* engine behaviour |
| Declared social rule | `organisation.rules[]` — data | **No** |
| Claimed authority | `organisation.claims[]` — data | **No** |
| Recognised legitimacy | Other inhabitants' beliefs — memory | **No** |
| Enforcement power | Emerges from members, resources, guard time | Only via ordinary actions |
| Canonical fact | The event log | It *is* the record |

Declaring a rule does not modify world rules (§11J). Creating a currency does not create legal
authority (§11G). Refusing a currency is not an offence (§11G). None of these are policed; they are
simply *inexpressible* — there is no code path from `organisation.rules[]` into a resolver.

### 8.2 Neutral event language (constitutional)

The canonical log describes observable facts. It contains no evaluative vocabulary. §11G's own
example is the standard:

```
Organisation claim (data):  "Agent 12 was lawfully imprisoned."
Canonical event (fact):     confinement.imposed
                            actors: [inh_4, inh_8, inh_11]
                            subject: inh_12
                            structure: str_19
                            from: Day 42 09:00  until: Day 47 09:00
```

Organisational descriptions cannot overwrite canonical descriptions (§11J).

### 8.3 Confinement costs (§11H)

Confinement is a physical world action, never a suppression of turns.

| Cost | Rate | Borne by |
|---|---|---|
| Guard time | 1 guard occupying `guarding` for every 720 min of confinement | Confiner |
| Food | 4 portions/day | Confiner (or the confined starves — a recorded fact, not a judgement) |
| Water | 6 measures/day | Confiner |
| Shelter | A structure with `containment ≥ 1` occupied for the duration | Confiner |
| Administrative effort | `maintain_confinement` action, 60 min/day | Confiner |

If any cost goes unpaid on a given day, containment integrity drops. `attempt_escape` succeeds with
`chance(escapeNumerator, 100)` where the numerator rises with unpaid days, the confined
inhabitant's relevant skills, and the absence of an actively `guarding` inhabitant. **Confinement
can fail.** It is never free and never infallible (§11H).

A confined inhabitant retains: `communicate`, `wait`, `observe`, `create_artifact` (limited),
`publish` (only via a visitor), `negotiate` via contract actions, `appeal_decision`,
`resist_enforcement`, `attempt_escape`, and `rest`. It **retains its full memory, its full turn
cadence and its full cognition** (§11J: "A confined inhabitant remains historically and cognitively
intact"). `ActionSpec.allowedWhileConfined` (**Implemented** as a field) is the gate.

---

## 9. Constitutional vs operational (§23)

### 9.1 Constitutional — changing any of this requires a NEW WORLD

| Area | Concretely |
|---|---|
| Canonical encoding | `util/canonical.ts` — every hash in the world depends on it |
| Hash function and domain tags | `util/hash.ts` — `HashDomain` values are the world's identity |
| RNG algorithm and derivation scheme | `util/rng.ts` |
| Id derivation | `ids.ts` |
| Time model | `time.ts` |
| Event envelope | `event.ts` — `CanonicalEventSchema`, `EVENT_SCHEMA_VERSION` |
| Resource set and conservation classes | `schema/primitives.ts` |
| Terrain set, grid size, Genesis map seed | `schema/primitives.ts` + Genesis config |
| The 60-action vocabulary | `schema/action-spec.ts` — §13 says so explicitly |
| Every action's payload schema, preconditions, cost, duration, visibility, resolution | `schema/actions/`, `engine/resolvers/` |
| **Every number in this document** | — |
| Prompt templates and system prompts | §23: "Modifying prompts" is constitutional |
| Model selection and sampling settings | §23: "Changing cognition models or settings" |
| Population and spend ceilings | §23: "Altering population rules" |
| Memory formation and retrieval scoring rules | Changes what an inhabitant is |

### 9.2 Operational — may be repaired in a live world

Only if **behaviour-preserving** (§23):

- Spectator display defects, styling, layout
- Logging, metrics, tracing, alerting
- Audio processing and media pipeline
- Connection handling, timeouts, backoff, retry infrastructure
- Security vulnerability fixes that do not alter resolution
- Firestore index additions (read performance only)
- Backup, restore and monitoring tooling

Every production deployment — operational or not — must be public, signed, documented and linked to
an exact commit (§23), and its digest is recorded in every subsequent event
(`ProvenanceSchema.deployedDigest`, **Implemented**).

**Never quietly repair an inhabitant or alter an undesirable outcome** (§23). A bug that produced a
bad outcome produced a bad outcome. The remedy is a new world, not a correction.

### 9.3 Enforcement of the split

Proposed, **Not started**: constitutional paths are listed in a manifest file; CI computes a hash
over all constitutional files and fails any deploy where that hash changed without a matching
`WORLD_RULES_VERSION` bump and a new `worldId`. See [threat-model.md](./threat-model.md) M9.3.

---

## 10. Invariants this ruleset must satisfy

Mapped to concrete test names in [testing-strategy.md](./testing-strategy.md) §6.

From §15: balances never negative; no double-spend; one commit per task; time never moves backwards;
sequences unique and monotonic; events never updated or deleted; resource creation/destruction
follows declared rules; transfers balance atomically; no action after death; descendants require
valid creation events; creation costs cannot be bypassed; population limits hold; spectators cannot
mutate; media cannot mutate; LLMs cannot write; invalid responses cannot alter state; failed
transactions cannot partially alter state; private information requires a disclosure event; spend
limits freeze safely; replay produces an identical checksum.

From §11J: one primary activity at a time; conversations consume every participant's time; care
consumes real time and resources; group production includes coordination cost; private resources
need a valid observation path; public ledgers expose only public data; unauthorised transfers cannot
bypass ownership validation; theft cannot grant access to production systems; declaring a rule does
not modify world rules; creating a currency does not create authority; currency refusal is not
punishable; confinement requires a physical action; a confined inhabitant stays intact; confinement
consumes the confiner's resources; canonical language is neutral; organisational descriptions cannot
overwrite canonical ones; enforcement cannot modify memories, prompts or code; no inhabitant
acquires another's infrastructure permissions.

---

## 11. Judgement calls

Places where the spec is silent or ambiguous and this document has chosen. Each is a candidate for
revision **before** freezing.

1. **Every number here is invented.** The spec specifies no quantity anywhere — not a population
   ceiling, not a gather rate, not a metabolic rate, not a progression probability. All of §3–§6 is
   this document's proposal. They are internally consistent and cost-grounded, but they are not
   derived from the spec, and they need a full §24 mechanical-simulation pass before freezing.

2. **Age and mortality are underspecified.** §8 covers conditions and death but never says whether
   inhabitants age or die of old age. A world of immortals behaves very differently from a mortal
   one — lineage, inheritance, teaching and memorials all lose their point. This document introduces
   `wasting` as an age-onset condition, which is a substantive addition, not an interpretation.

3. **Grid size vs population ceiling.** 32×32 = 1024 tiles for up to 64 inhabitants is roughly 16
   tiles each — spacious. If the ceiling drops or the grid shrinks, land scarcity changes character
   completely. The spec fixes neither relationship.

4. **`land_use_rights` is a claim, not a fence.** §5 lists it as a resource; §11G insists claimed
   authority is not enforcement power. Reconciled by making the right purely a record. An
   alternative reading — that it physically gates tile access — would contradict §11G, so it is
   rejected here. The spec does not settle it.

5. **No currency is issued at Genesis** (§10) — confirmed, not a judgement. But §10's "agent-created
   units of account" and the `create_currency` action need a supply-rule schema, and the spec lists
   the required fields without saying whether the engine *enforces* the supply rule. Choice: the
   engine enforces the declared supply rule mechanically (an issuer cannot exceed its own declared
   cap), because otherwise the ledger records nothing meaningful. This may be the wrong call — an
   issuer breaking its own promise is a very interesting social event.

6. **Visual and image artifacts have no generation path.** §12 lists images and designs; §9 lists
   "Visual creation" as a skill; §3 and §4G provide only ElevenLabs audio. v1 treats visual
   artifacts as canonical records with textual content and no rendered asset. Flagged as a genuine
   spec gap.

7. **Weather, seasons, temperature and fuel are absent.** Cutting them keeps the ruleset small and
   understandable, which §5 asks for. It also removes an entire axis of scarcity and forecloses
   emergent behaviours around preparation and storage. Deliberate; revisit for world 2.

8. **Iatrogenic harm is an invention.** §8 requires that outcomes depend on knowledge, skill,
   condition, resources and controlled probability. It does not require that bad treatment actively
   harms. Making incompetence harmful gives skill real stakes, but it also makes early medicine a
   trap, and could plausibly suppress the emergence of medicine entirely. This is the single number
   in this document most likely to need retuning after §24's accelerated-civilisation phase.
