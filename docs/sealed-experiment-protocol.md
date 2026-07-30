# Sealed experiment protocol

This document defines what After Genesis may claim about a run. A valid event
hash chain proves that a record has not changed. It does not, by itself, prove
that the run was unscripted, sealed or scientifically useful.

## Public claim

Inhabitants were not assigned a civilisational objective, rewarded for
milestones, or mechanically required to produce evaluator-labelled outcomes.
Before Genesis, humans fixed the world physics, neutral action primitives,
initial state, models and memory policy. After Genesis, no human supplied action
choices, messages, resources, corrections or prompt changes. Every recorded
attempt was proposed by an inhabitant from its bounded context and resolved
through fixed world mechanics. The append-only record traces each development
to the observations, communications, experiments and earlier events that
preceded it.

This claim applies only to a run classified `sealed_experiment` whose Genesis
manifest verifies. It does not apply to development runs or fixtures.

## Pre-Genesis commitments

Sequence zero commits to:

- the immutable inhabitant protocol and structured response schema;
- world rules and the neutral capability schema;
- the complete initial state and random seed;
- exact model identifiers, inference parameters and retry policy;
- memory selection and retention policy;
- source commit and deployed runtime digest;
- one initial founder;
- evaluation criteria kept outside inhabitant context; and
- an intervention policy with every post-Genesis human write set to false.

Changing one of these starts a different world. It does not update a sealed
world.

## Inhabitant turn contract

`TURN_PACKET` is the inhabitant's only source for a turn. It distinguishes
direct observations, remembered experiences, reported statements, beliefs and
engine-confirmed outcomes. Every citable item has a packet-local provenance ID.

The inhabitant returns exactly:

```json
{
  "attempt": {
    "capability": "move",
    "target_ids": [],
    "parameters": { "to": { "x": 1, "y": 2 } },
    "requested_duration_ticks": 1,
    "message": null
  },
  "decision_record": {
    "priority_now": "inspect a different local area",
    "basis_ids": ["self:inh_founder", "observed:tile:1,2"],
    "basis_summary": "the adjacent tile is directly visible",
    "expected_local_change": "my recorded position changes",
    "success_test": "the next packet reports the new position",
    "uncertainties": []
  },
  "future_note": null
}
```

The boundary rejects unknown packet IDs and missing capability parameters. It
does not guess or repair meaning. Model prose changes no state. The deterministic
engine validates geometry, access, resources, time and conservation, then
records either a resolved, partial or rejected attempt.

The model-facing vocabulary does not contain evaluator outcomes such as
government, currency, profession, prison or civilisation. Generic assemblies
receive only geometry/material-derived affordances; their label grants no
shelter, security or extra storage. Biological replication is a neutral world
process rather than an evaluator milestone, and remains subject to time, matter
and care constraints.

## Memory

Each turn records the attempted capability, prospective decision record,
engine-confirmed outcome and optional future note. Future notes are the
inhabitant's beliefs or intentions, not canonical world facts. Historical
records are appended, never silently rewritten.

## Evaluation

The survival-to-civilisation hierarchy is an evaluator rubric only. It is fixed
before Genesis, hashed in the manifest and withheld from every inhabitant. It is
applied after a run to the append-only causal record.

Stagnation, collapse and extinction remain valid results. A completed run is not
reported as a civilisation result merely because it stayed alive or passed
replay verification.

## Public classifications

- `SEALED EXPERIMENT`: live source plus a verified sequence-zero manifest hash.
- `DEVELOPMENT RUN`: mutable code, prompts, controls or operator intervention
  may be present.
- `DEVELOPMENT FIXTURE`: committed or generated presentation data.
- `INVALIDATED RUN`: a formerly sealed attempt whose declared policy was broken.

Fixtures and development runs must never inherit the sealed label from a valid
hash chain alone.
