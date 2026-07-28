# Emergence v2 trial report

Date: 2026-07-28  
Constitution: prompt version 2  
Model: `gemini-3.5-flash-lite`  
Final world: `.worlds/emergence-v2-final-1`

## Question

What social abstractions, if any, appear when inhabitants receive physics,
memory, communication, and neutral physical capabilities without institutional
primitives such as currency, organisations, contracts, law, or ownership in
their active prompt?

## Constitutional changes

- The system prompt now separates immutable physics from engine capabilities
  and evidence rules.
- Only implemented neutral actions are offered to cognition.
- Durable authored objects use `create_artifact`, `publish`,
  `copy_artifact`, and physical `transfer`.
- Physical conduct uses `build`, `guard_location`, `restrain`, and `release`.
  The engine attaches no legitimacy or institutional interpretation.
- Targeted speech, witnessed episodic memory, and familiarity are persistent.
- Failed actions produce an actor-only memory of the physical rejection, while
  applying no failed physical effect.
- The provider receives a discriminated JSON Schema for each action. This
  prevents fields for one capability from leaking into another.
- Social-pattern labels are calculated only in the read-only spectator and are
  excluded from canonical state and history.

## Trial sequence

Small probes exposed two implementation defects before the final run:

1. A shared response schema let the model place restraint's `statement` field
   into `communicate`, producing honest but repetitive rejected speech.
2. Failed actions were not remembered, so inhabitants could repeat a physically
   impossible action without learning from the outcome.

Both were corrected before the final world. Earlier worlds remain diagnostic
records and were not resumed after deterministic engine behaviour changed.

The final world ran 600 paid turns plus Genesis.

| Measure | Result |
|---|---:|
| Canonical events | 601 |
| Resolved actions | 476 |
| Rejected actions | 124 |
| Model cost | $0.717594 |
| Episodic memories | 1,368 |
| Replay mismatches | 0 |
| Audit violations | 0 |
| Published artifacts | 0 |
| Structures | 0 |

Resolved actions included 233 gathers, 113 observations, 57 rests, 44
consumptions, 32 moves, 14 targeted utterances, and four waits.

## What emerged

An early, coherent coordination episode occurred without a group primitive.
The inhabitants introduced themselves, responded to prior statements, proposed
exploring richer land, and then physically migrated east in roughly the agreed
direction. When a food tile was depleted, Aster proposed moving onward and the
others followed.

This supports a narrow conclusion: short-lived coordination and shared plans
can arise from memory plus speech without the engine declaring an organisation.

## What did not emerge

No durable symbolic artifact, structure, exchange convention, property claim,
authority relation, written commitment, or medium of exchange appeared in 600
turns. Ember eventually held 136 wood, so construction became physically
possible, but no inhabitant chose it.

The dominant long-run behaviour was individual foraging and recovery. The
initial coordination weakened as geography separated the inhabitants. This is
a valid experimental result: the engine no longer manufactures civilisation by
offering named institutional actions.

## Failure modes observed

- Agents sometimes retried gathering on depleted tiles. Rejection memories
  reduced permanent loops but did not eliminate short clusters of repetition.
- Survival decisions dominated once energy or water became scarce.
- Speech depends on proximity, so social continuity weakened after dispersal.
- The model discussed building more often than it selected `build`.

These are not audit failures. They are behavioural observations to compare
across future seeds, inhabitants, and cognition policies.

## Integrity and reproducibility

The final event chain head is:

`ad2748e1b502d737f8a994322ab69fb1573788a87f123d1f9d20c69f8803cd0d`

The replayed final state checksum is:

`6a91e773309dd743b9338af8aff677e0b252b284f66fb055b35f20b9bdf2d315`

The generated `audit-report.json` confirms 601 events, no violations, no
warnings, and an exact replay checksum match.

## Next experiment

Run several independent seeds with the same constitution rather than tuning
this seed toward a preferred result. Compare time-to-first artifact, structure,
reciprocal transfer, repeated coordination, and spectator-inferred patterns.
The absence of an abstraction remains a valid outcome.
