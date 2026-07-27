/**
 * World invariants (§15, §11J).
 *
 * These are the properties that must hold after *every* canonical event. They
 * are checked, not assumed: an engine that merely intends to conserve resources
 * is an engine that will one day quietly stop conserving them, and the only
 * evidence would be a checksum mismatch weeks later with no explanation.
 *
 * Two deliberate design choices:
 *
 * - **Violations are returned, never thrown.** A thrown error inside a resolver
 *   could unwind halfway through a state transition; §15 requires that "failed
 *   transactions cannot partially alter state". The caller decides whether a
 *   violation halts the world (it should) — this module only reports.
 *
 * - **Each rule is a separate named function** quoting the spec line it
 *   enforces, so that an auditor reading §15 can find the code for any line,
 *   and so that a violation names the rule rather than a line number.
 */
import { CONSERVED_RESOURCES, RESOURCE_KINDS, chebyshevDistance } from "../schema/primitives.js";
import type { ResourceBundle } from "../schema/primitives.js";
import {
  CONFINEMENT_GROUNDS_CODES,
  computeRulesChecksum,
  sortedIds,
  sortedValues,
  terrainAt,
  totalHeldResources,
  type Inhabitant,
  type WorldState,
} from "./state.js";

/** A specific, located breach of a specific rule. */
export interface InvariantViolation {
  /** Stable machine-readable id, e.g. `no_negative_balances`. */
  readonly invariant: string;
  /** The spec clause being enforced, quoted. */
  readonly spec: string;
  /** The entity at fault, or `null` for a whole-world property. */
  readonly subject: string | null;
  readonly detail: string;
}

type Check = (state: WorldState) => InvariantViolation[];

const violation = (
  invariant: string,
  spec: string,
  subject: string | null,
  detail: string,
): InvariantViolation => ({ invariant, spec, subject, detail });

/* ------------------------------------------------------------------------- */
/* §15 — Balances cannot become negative.                                     */
/* ------------------------------------------------------------------------- */

/**
 * §15: "Balances cannot become negative."
 *
 * Checked over every place a quantity can be held, including the ones easy to
 * forget: concealed storage, structure storage, organisation property and the
 * tile deposits themselves.
 */
export const noNegativeBalances: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§15 Balances cannot become negative.";

  const scan = (subject: string, label: string, bundle: ResourceBundle): void => {
    for (const kind of RESOURCE_KINDS) {
      const amount = bundle[kind] ?? 0;
      if (!Number.isSafeInteger(amount)) {
        out.push(
          violation(
            "no_negative_balances",
            spec,
            subject,
            `${label}.${kind} is ${String(amount)}, which is not a safe integer`,
          ),
        );
      } else if (amount < 0) {
        out.push(
          violation("no_negative_balances", spec, subject, `${label}.${kind} is ${amount}`),
        );
      }
    }
  };

  for (const key of sortedIds(state.deposits)) scan(key, "deposit", state.deposits[key] ?? {});
  for (const i of sortedValues(state.inhabitants)) {
    scan(i.id, "inventory", i.inventory);
    scan(i.id, "concealed", i.concealed);
    scan(i.id, "exposed", i.exposed);
  }
  for (const s of sortedValues(state.structures)) scan(s.id, "storage", s.storage);
  for (const o of sortedValues(state.organisations)) scan(o.id, "property", o.property);

  for (const c of sortedValues(state.currencies)) {
    for (const holder of sortedIds(c.holdings)) {
      const amount = c.holdings[holder] ?? 0;
      if (amount < 0) {
        out.push(
          violation(
            "no_negative_balances",
            spec,
            c.id,
            `currency holding for ${holder} is ${amount}`,
          ),
        );
      }
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §15 — Resource creation and destruction follow declared rules.             */
/* ------------------------------------------------------------------------- */

/**
 * §15: "Resource creation and destruction follow declared rules."
 * §5: "Define explicit sources, sinks and conservation rules for every resource."
 *
 * For every conserved resource:
 *
 *     heldNow + destroyed === genesisTotal + created
 *
 * Gathering does not appear in this equation because it is not a source: it
 * moves units from a tile deposit to an inventory, and both are counted in
 * `heldNow`. A resolver that "gathered" more than it depleted would break this
 * on the very next check. `energy` and `compute` are exempt by
 * `CONSERVED_RESOURCES` — they regenerate from rest and are destroyed by use.
 */
export const conservedResourceTotals: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§15 Resource creation and destruction follow declared rules.";
  const held = totalHeldResources(state);
  for (const kind of RESOURCE_KINDS) {
    if (!CONSERVED_RESOURCES.has(kind)) continue;
    const left = (held[kind] ?? 0) + (state.ledger.destroyed[kind] ?? 0);
    const right = (state.ledger.genesisTotal[kind] ?? 0) + (state.ledger.created[kind] ?? 0);
    if (left !== right) {
      out.push(
        violation(
          "conserved_resource_totals",
          spec,
          null,
          `${kind}: held ${held[kind] ?? 0} + destroyed ${state.ledger.destroyed[kind] ?? 0} ` +
            `= ${left}, but genesis ${state.ledger.genesisTotal[kind] ?? 0} + created ` +
            `${state.ledger.created[kind] ?? 0} = ${right}`,
        ),
      );
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §11J — An inhabitant cannot occupy two primary activities simultaneously.  */
/* ------------------------------------------------------------------------- */

/**
 * §11J: "An inhabitant cannot occupy two primary activities simultaneously."
 * §11A: "Every inhabitant may participate in only one primary activity at any
 * simulated moment."
 *
 * Two things are checked. First, no inhabitant appears in two *open* activity
 * records. Second, an inhabitant's own `activity` handle agrees with the
 * registry — an idle inhabitant holds no activity id, a busy one holds exactly
 * one that exists and lists it as a participant.
 */
export const singlePrimaryActivity: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J An inhabitant cannot occupy two primary activities simultaneously.";
  const openBy = new Map<string, string[]>();

  for (const activity of sortedValues(state.activities)) {
    if (!activity.open) continue;
    for (const participant of [...activity.participants].sort()) {
      const list = openBy.get(participant) ?? [];
      list.push(activity.id);
      openBy.set(participant, list);
    }
  }

  for (const inhabitant of sortedValues(state.inhabitants)) {
    const open = openBy.get(inhabitant.id) ?? [];
    if (open.length > 1) {
      out.push(
        violation(
          "single_primary_activity",
          spec,
          inhabitant.id,
          `participates in ${open.length} open activities: ${open.sort().join(", ")}`,
        ),
      );
    }
    const handle = inhabitant.activity;
    // Holding no activity means being idle. The converse is not required:
    // `wait` books an activity whose state is legitimately `idle`, because
    // deliberate idleness still consumes the clock (§11A).
    if (handle.activityId === null && handle.state !== "idle") {
      out.push(
        violation(
          "single_primary_activity",
          spec,
          inhabitant.id,
          `holds no activity but reports state "${handle.state}"`,
        ),
      );
    }
    if (handle.activityId !== null) {
      const record = state.activities[handle.activityId];
      if (record === undefined) {
        out.push(
          violation(
            "single_primary_activity",
            spec,
            inhabitant.id,
            `holds activity ${handle.activityId} which does not exist`,
          ),
        );
      } else if (!record.participants.includes(inhabitant.id)) {
        out.push(
          violation(
            "single_primary_activity",
            spec,
            inhabitant.id,
            `holds activity ${handle.activityId} but is not one of its participants`,
          ),
        );
      }
    }
  }
  return out;
};

/**
 * §11J: "Conversations consume time for every participant."
 * §11A: "Conversations, childcare, employment, travel, education, healthcare,
 * guarding and rest consume time that cannot simultaneously be used elsewhere."
 *
 * A conversing or caring activity with zero duration would let an inhabitant
 * talk for free, which is exactly the free-lunch §11A forbids. Every
 * participant's own `busyUntil` must also reach the activity's end — otherwise
 * only the initiator would pay.
 */
export const activitiesConsumeParticipantTime: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Conversations consume time for every participant.";
  for (const activity of sortedValues(state.activities)) {
    if (activity.endsAt <= activity.startedAt) {
      out.push(
        violation(
          "activities_consume_participant_time",
          spec,
          activity.id,
          `${activity.actionType} occupies zero simulated time ` +
            `(${activity.startedAt} -> ${activity.endsAt})`,
        ),
      );
    }
    if (activity.participants.length === 0) {
      out.push(
        violation(
          "activities_consume_participant_time",
          spec,
          activity.id,
          "activity has no participants, so nobody paid for it",
        ),
      );
    }
    if (!activity.open) continue;
    for (const participant of [...activity.participants].sort()) {
      const inhabitant = state.inhabitants[participant];
      if (inhabitant === undefined) continue;
      if (inhabitant.activity.busyUntil < activity.endsAt) {
        out.push(
          violation(
            "activities_consume_participant_time",
            spec,
            participant,
            `is free at ${inhabitant.activity.busyUntil} but open activity ` +
              `${activity.id} runs until ${activity.endsAt}`,
          ),
        );
      }
    }
  }
  return out;
};

/**
 * §11J: "Care consumes actual time and resources."
 * §11C: "Care must consume the carer's time and potentially other resources."
 */
export const careConsumesTimeAndResources: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Care consumes actual time and resources.";
  for (const activity of sortedValues(state.activities)) {
    if (activity.state !== "caring") continue;
    if (activity.endsAt <= activity.startedAt) {
      out.push(
        violation(
          "care_consumes_time_and_resources",
          spec,
          activity.id,
          "care activity occupies zero simulated time",
        ),
      );
    }
    const spent = RESOURCE_KINDS.some((kind) => (activity.resourceCost[kind] ?? 0) > 0);
    if (!spent) {
      out.push(
        violation(
          "care_consumes_time_and_resources",
          spec,
          activity.id,
          "care activity recorded no resource cost at all",
        ),
      );
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §15 — Sequence numbers and world time.                                     */
/* ------------------------------------------------------------------------- */

/**
 * §15: "Sequence numbers are unique and monotonic."
 *
 * The state's sequence is the highest applied event. Nothing in the world may
 * claim to have been created by an event that has not happened yet.
 */
export const sequenceMonotonic: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§15 Sequence numbers are unique and monotonic.";
  const check = (subject: string, label: string, sequence: number): void => {
    if (!Number.isSafeInteger(sequence)) {
      out.push(
        violation("sequence_monotonic", spec, subject, `${label} ${String(sequence)} is not an integer`),
      );
    } else if (sequence > state.sequence) {
      out.push(
        violation(
          "sequence_monotonic",
          spec,
          subject,
          `${label} ${sequence} is ahead of the world sequence ${state.sequence}`,
        ),
      );
    }
  };

  if (state.sequence < -1) {
    out.push(
      violation("sequence_monotonic", spec, null, `world sequence ${state.sequence} is below -1`),
    );
  }
  for (const i of sortedValues(state.inhabitants)) {
    check(i.id, "creationSequence", i.creationSequence);
    if (i.deathSequence !== null) check(i.id, "deathSequence", i.deathSequence);
  }
  for (const s of sortedValues(state.structures)) check(s.id, "createdSequence", s.createdSequence);
  for (const a of sortedValues(state.artifacts)) check(a.id, "createdSequence", a.createdSequence);
  for (const o of sortedValues(state.organisations)) check(o.id, "createdSequence", o.createdSequence);
  for (const c of sortedValues(state.contracts)) check(c.id, "createdSequence", c.createdSequence);
  for (const c of sortedValues(state.currencies)) check(c.id, "createdSequence", c.createdSequence);
  for (const c of sortedValues(state.conditions)) check(c.id, "createdSequence", c.createdSequence);
  for (const a of sortedValues(state.activities)) check(a.id, "sequence", a.sequence);
  for (const m of sortedValues(state.memories)) check(m.id, "sequence", m.sequence);
  for (const c of sortedValues(state.confinements)) check(c.id, "createdSequence", c.createdSequence);
  return out;
};

/**
 * §15: "World time cannot move backwards."
 *
 * Enforced at the point of change by `withSimTime`; re-checked here because
 * every recorded instant in the world must also lie at or before now. A birth
 * time in the future would mean the state was assembled out of order.
 */
export const simTimeNonDecreasing: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§15 World time cannot move backwards.";
  const check = (subject: string, label: string, time: number): void => {
    if (!Number.isSafeInteger(time) || time < 0) {
      out.push(violation("sim_time_non_decreasing", spec, subject, `${label} ${String(time)} is invalid`));
    } else if (time > state.simTime) {
      out.push(
        violation(
          "sim_time_non_decreasing",
          spec,
          subject,
          `${label} ${time} is after world time ${state.simTime}`,
        ),
      );
    }
  };

  if (!Number.isSafeInteger(state.simTime) || state.simTime < 0) {
    out.push(
      violation("sim_time_non_decreasing", spec, null, `world simTime ${String(state.simTime)} is invalid`),
    );
    return out;
  }
  for (const i of sortedValues(state.inhabitants)) {
    check(i.id, "birthTime", i.birthTime);
    if (i.lastActionTime !== null) check(i.id, "lastActionTime", i.lastActionTime);
    if (i.deathTime !== null) check(i.id, "deathTime", i.deathTime);
  }
  for (const a of sortedValues(state.activities)) check(a.id, "startedAt", a.startedAt);
  for (const m of sortedValues(state.memories)) check(m.id, "simTime", m.simTime);
  for (const announcement of state.publicRecords.announcements) {
    check(`announcement@${announcement.sequence}`, "simTime", announcement.simTime);
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §15 — Death.                                                               */
/* ------------------------------------------------------------------------- */

/**
 * §15: "Inhabitants cannot act after death."
 * §8: "Death must never delete history. Mark the inhabitant inactive and
 * preserve memories, relationships, property, contracts, artifacts, messages,
 * reputation, lineage, complete event history."
 *
 * The dead are idle, hold no open activity, have a recorded death event, and
 * took no action after it. Their records stay exactly where they were.
 */
export const deadInhabitantsCannotAct: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§15 Inhabitants cannot act after death.";
  for (const i of sortedValues(state.inhabitants)) {
    if (i.status === "alive") {
      if (i.deathTime !== null || i.deathSequence !== null) {
        out.push(
          violation(
            "dead_inhabitants_cannot_act",
            spec,
            i.id,
            "is alive but carries a death event",
          ),
        );
      }
      continue;
    }
    if (i.deathTime === null || i.deathSequence === null) {
      out.push(
        violation("dead_inhabitants_cannot_act", spec, i.id, "is dead with no recorded death event"),
      );
    }
    if (i.activity.state !== "idle" || i.activity.activityId !== null) {
      out.push(
        violation(
          "dead_inhabitants_cannot_act",
          spec,
          i.id,
          `is dead but occupies activity "${i.activity.state}"`,
        ),
      );
    }
    if (i.deathTime !== null && i.lastActionTime !== null && i.lastActionTime > i.deathTime) {
      out.push(
        violation(
          "dead_inhabitants_cannot_act",
          spec,
          i.id,
          `acted at ${i.lastActionTime}, after dying at ${i.deathTime}`,
        ),
      );
    }
    if (i.deathTime !== null && i.nextEligibleTime > i.deathTime) {
      out.push(
        violation(
          "dead_inhabitants_cannot_act",
          spec,
          i.id,
          `is scheduled to act at ${i.nextEligibleTime}, after dying at ${i.deathTime}`,
        ),
      );
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §15 — Population and lineage.                                              */
/* ------------------------------------------------------------------------- */

/**
 * §15: "Population limits cannot be exceeded."
 * §7: "Creation must respect population and spending ceilings."
 *
 * The ceiling counts the living. The dead are preserved forever (§8) and must
 * never consume a slot, or a world would eventually be unable to reproduce
 * because of its own history.
 */
export const populationCeiling: Check = (state) => {
  const spec = "§15 Population limits cannot be exceeded.";
  const living = sortedValues(state.inhabitants).filter((i) => i.status === "alive").length;
  if (living > state.rules.populationLimit) {
    return [
      violation(
        "population_ceiling",
        spec,
        null,
        `${living} living inhabitants exceeds the ceiling of ${state.rules.populationLimit}`,
      ),
    ];
  }
  return [];
};

/**
 * §15: "Descendants require valid creation events."
 * §7: "All later inhabitants must be created using a validated world action
 * initiated by an existing inhabitant."
 *
 * Exactly one inhabitant may have no parent: the founder, created at Genesis
 * (sequence 0). Everyone else names at least one parent that exists, and was
 * created by a later event than that parent.
 */
export const descendantsRequireCreationEvents: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§15 Descendants require valid creation events.";
  const founders: string[] = [];
  for (const i of sortedValues(state.inhabitants)) {
    if (i.parents.length === 0) {
      founders.push(i.id);
      if (i.creationSequence !== 0) {
        out.push(
          violation(
            "descendants_require_creation_events",
            spec,
            i.id,
            `has no parent but was created at sequence ${i.creationSequence}, not at Genesis`,
          ),
        );
      }
      continue;
    }
    for (const parent of [...i.parents].sort()) {
      const record = state.inhabitants[parent];
      if (record === undefined) {
        out.push(
          violation(
            "descendants_require_creation_events",
            spec,
            i.id,
            `names parent ${parent}, who does not exist`,
          ),
        );
      } else if (record.creationSequence >= i.creationSequence) {
        out.push(
          violation(
            "descendants_require_creation_events",
            spec,
            i.id,
            `was created at sequence ${i.creationSequence}, at or before its parent ` +
              `${parent} at ${record.creationSequence}`,
          ),
        );
      }
    }
  }
  if (founders.length > 1) {
    out.push(
      violation(
        "descendants_require_creation_events",
        spec,
        null,
        `the world has ${founders.length} parentless inhabitants (${founders.join(", ")}); ` +
          "§7 permits exactly one, instantiated at Genesis",
      ),
    );
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §11J — Information visibility.                                             */
/* ------------------------------------------------------------------------- */

/**
 * §11J: "Private resources are not exposed without a valid observation or
 * disclosure path."
 *
 * `exposed` marks the subset of `inventory` an inhabitant is openly carrying.
 * It is what `buildObservation` shows to others, so if it could exceed
 * `inventory` an inhabitant could advertise goods it does not hold — and if it
 * could contain items sourced from `concealed`, hidden storage would leak by
 * accident.
 */
export const exposedIsBackedByInventory: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec =
    "§11J Private resources are not exposed without a valid observation or disclosure path.";
  for (const i of sortedValues(state.inhabitants)) {
    for (const kind of RESOURCE_KINDS) {
      const exposed = i.exposed[kind] ?? 0;
      const held = i.inventory[kind] ?? 0;
      if (exposed > held) {
        out.push(
          violation(
            "exposed_is_backed_by_inventory",
            spec,
            i.id,
            `displays ${exposed} ${kind} but holds only ${held}`,
          ),
        );
      }
    }
  }
  return out;
};

/**
 * §11J: "Public ledgers expose only information defined as public."
 * §10: currency creation requires an "ownership ledger".
 *
 * A currency's holdings must sum to exactly its issued supply, whether or not
 * the ledger is public. A private ledger is still a ledger; secrecy is not an
 * excuse to stop balancing.
 */
export const currencyLedgersBalance: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Public ledgers expose only information defined as public.";
  for (const c of sortedValues(state.currencies)) {
    let total = 0;
    for (const holder of sortedIds(c.holdings)) total += c.holdings[holder] ?? 0;
    if (total !== c.issuedSupply) {
      out.push(
        violation(
          "currency_ledgers_balance",
          spec,
          c.id,
          `holdings sum to ${total} but issued supply is ${c.issuedSupply}`,
        ),
      );
    }
    if (state.inhabitants[c.issuer] === undefined && state.organisations[c.issuer] === undefined) {
      out.push(
        violation("currency_ledgers_balance", spec, c.id, `issuer ${c.issuer} does not exist`),
      );
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §11J — Law, authority and enforcement.                                     */
/* ------------------------------------------------------------------------- */

/**
 * §11J: "Declaring a rule does not modify immutable world rules."
 * §11G: "An organisation may declare rules, but declaration alone does not make
 * those rules universal."
 *
 * Organisational rules live inside `Organisation.rules` and can say anything
 * they like. `WorldState.rules` is hashed at Genesis and re-hashed here; if the
 * two disagree, something outside the constitution changed physics.
 */
export const worldRulesUnchanged: Check = (state) => {
  const spec = "§11J Declaring a rule does not modify immutable world rules.";
  const actual = computeRulesChecksum(state.rules);
  if (actual !== state.rulesChecksum) {
    return [
      violation(
        "world_rules_unchanged",
        spec,
        null,
        `world rules hash to ${actual.slice(0, 12)}… but Genesis recorded ` +
          `${state.rulesChecksum.slice(0, 12)}…`,
      ),
    ];
  }
  return [];
};

/**
 * §11J: "Creating a currency does not create automatic legal authority."
 * §11G: "A rule applies socially only to the extent that inhabitants recognise
 * it, agree to it or can be compelled to follow it."
 *
 * An organisation may *claim* jurisdiction over anyone. The engine only lets
 * that claim stand where there is a recognised or physical basis: the person is
 * a member (agreement) or is being physically confined by that organisation
 * (compulsion). Issuing a currency grants neither, so a currency issuer cannot
 * silently acquire subjects.
 */
export const claimedAuthorityRequiresMembershipOrConfinement: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Creating a currency does not create automatic legal authority.";
  for (const org of sortedValues(state.organisations)) {
    const confinedByOrg = new Set(
      sortedValues(state.confinements)
        .filter((c) => !c.released && c.organisation === org.id)
        .map((c) => c.subject),
    );
    for (const subject of [...org.claimedJurisdiction].sort()) {
      if (org.members.includes(subject)) continue;
      if (confinedByOrg.has(subject)) continue;
      out.push(
        violation(
          "claimed_authority_requires_membership_or_confinement",
          spec,
          org.id,
          `claims jurisdiction over ${subject}, who is neither a member nor confined by it; ` +
            "declaration alone binds nobody",
        ),
      );
    }
  }
  return out;
};

/**
 * §11J: "Currency refusal is not automatically punishable."
 * §11G: "Refusing to acquire, accept or use a currency is not automatically an
 * offence."
 *
 * Enforced by vocabulary: confinement must cite one of the neutral grounds
 * codes, and there is no code for currency refusal. An organisation may still
 * confine somebody and *say* it was about currency — but the canonical record
 * will describe only the physical fact (§11G), and the engine will never
 * validate "refused my currency" as a ground.
 */
export const confinementGroundsAreNeutral: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Currency refusal is not automatically punishable.";
  const allowed = new Set<string>(CONFINEMENT_GROUNDS_CODES);
  for (const c of sortedValues(state.confinements)) {
    if (!allowed.has(c.grounds)) {
      out.push(
        violation(
          "confinement_grounds_are_neutral",
          spec,
          c.id,
          `cites grounds "${c.grounds}", which is not one of the neutral codes ` +
            `[${[...allowed].sort().join(", ")}]`,
        ),
      );
    }
  }
  return out;
};

/**
 * §11J: "Confinement consumes resources for the confining party."
 * §11H: "Maintaining confinement must consume resources: guard time, food,
 * shelter, building capacity, administrative effort... Confinement cannot be a
 * free or infallible action."
 *
 * An active confinement must name a payer who exists, must be anchored to a
 * real structure that lists the subject as an occupant, and must have consumed
 * either guard time or goods. A confinement that costs nothing is a deleted
 * turn wearing a costume, which §11H explicitly forbids.
 */
export const confinementConsumesConfinersResources: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Confinement consumes resources for the confining party.";
  for (const c of sortedValues(state.confinements)) {
    if (c.released) continue;

    const paidGoods = RESOURCE_KINDS.some((kind) => (c.upkeepPaid[kind] ?? 0) > 0);
    if (!paidGoods && c.guardMinutes <= 0) {
      out.push(
        violation(
          "confinement_consumes_confiners_resources",
          spec,
          c.id,
          "is active but the confining party has spent neither guard time nor resources",
        ),
      );
    }
    const payerExists =
      state.inhabitants[c.upkeepPayer] !== undefined ||
      state.organisations[c.upkeepPayer] !== undefined;
    if (!payerExists) {
      out.push(
        violation(
          "confinement_consumes_confiners_resources",
          spec,
          c.id,
          `names upkeep payer ${c.upkeepPayer}, who does not exist`,
        ),
      );
    }
    if (c.imposedBy.length === 0) {
      out.push(
        violation(
          "confinement_consumes_confiners_resources",
          spec,
          c.id,
          "records nobody as having imposed it; confinement requires actors (§11H)",
        ),
      );
    }
    const structure = state.structures[c.structureId];
    if (structure === undefined) {
      out.push(
        violation(
          "confinement_consumes_confiners_resources",
          spec,
          c.id,
          `references structure ${c.structureId}, which does not exist`,
        ),
      );
    } else if (!structure.occupants.includes(c.subject)) {
      out.push(
        violation(
          "confinement_consumes_confiners_resources",
          spec,
          c.id,
          `holds ${c.subject} in structure ${c.structureId}, which does not list them as an occupant`,
        ),
      );
    }
  }
  return out;
};

/**
 * §11J: "A confined inhabitant remains historically and cognitively intact."
 * §11H: "Confinement must be implemented through world mechanics rather than
 * deleting turns or editing an inhabitant."
 *
 * The subject must still exist, still be alive, and must not have lost memories
 * since confinement began. Memories are append-only, so the count can only rise.
 */
export const confinedInhabitantsRemainIntact: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J A confined inhabitant remains historically and cognitively intact.";
  for (const c of sortedValues(state.confinements)) {
    if (c.released) continue;
    const subject = state.inhabitants[c.subject];
    if (subject === undefined) {
      out.push(
        violation(
          "confined_inhabitants_remain_intact",
          spec,
          c.id,
          `confines ${c.subject}, who does not exist`,
        ),
      );
      continue;
    }
    if (subject.confinementId !== c.id) {
      out.push(
        violation(
          "confined_inhabitants_remain_intact",
          spec,
          c.subject,
          `is confined by ${c.id} but records confinement ${String(subject.confinementId)}`,
        ),
      );
    }
    const owned = sortedValues(state.memories).filter((m) => m.owner === c.subject).length;
    if (owned < c.memoryCountAtStart) {
      out.push(
        violation(
          "confined_inhabitants_remain_intact",
          spec,
          c.subject,
          `held ${c.memoryCountAtStart} memories at confinement but holds ${owned} now; ` +
            "enforcement may not erase memory",
        ),
      );
    }
  }
  return out;
};

/**
 * §11J: "Enforcement cannot modify memories, prompts or source code."
 * §19: "Never silently rewrite historical memories. Corrections or changed
 * beliefs must create new memory records."
 *
 * A memory belongs to exactly one inhabitant, is keyed by its own id, and a
 * revision points at an existing earlier memory belonging to the same owner.
 * Nothing lets one inhabitant author a memory inside another.
 */
export const memoriesAreAppendOnlyAndOwned: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Enforcement cannot modify memories, prompts or source code.";
  for (const key of sortedIds(state.memories)) {
    const memory = state.memories[key];
    /* c8 ignore next */
    if (memory === undefined) continue;
    if (memory.id !== key) {
      out.push(
        violation(
          "memories_are_append_only_and_owned",
          spec,
          key,
          `is stored under key ${key} but claims id ${memory.id}`,
        ),
      );
    }
    if (state.inhabitants[memory.owner] === undefined) {
      out.push(
        violation(
          "memories_are_append_only_and_owned",
          spec,
          memory.id,
          `is owned by ${memory.owner}, who does not exist`,
        ),
      );
    }
    if (memory.revisionOf !== null) {
      const prior = state.memories[memory.revisionOf];
      if (prior === undefined) {
        out.push(
          violation(
            "memories_are_append_only_and_owned",
            spec,
            memory.id,
            `revises ${memory.revisionOf}, which does not exist`,
          ),
        );
      } else {
        if (prior.owner !== memory.owner) {
          out.push(
            violation(
              "memories_are_append_only_and_owned",
              spec,
              memory.id,
              `revises a memory owned by ${prior.owner}, not by its own owner ${memory.owner}`,
            ),
          );
        }
        if (prior.sequence > memory.sequence) {
          out.push(
            violation(
              "memories_are_append_only_and_owned",
              spec,
              memory.id,
              `revises a memory from a later sequence (${prior.sequence} > ${memory.sequence})`,
            ),
          );
        }
      }
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §15 — Ownership and referential integrity.                                 */
/* ------------------------------------------------------------------------- */

/**
 * §11J: "Unauthorised transfers cannot bypass ownership validation."
 * §15: "Transfers balance atomically."
 *
 * Every ownership pointer in the world must resolve. A dangling owner is how a
 * transfer half-commits: the asset leaves one holder and arrives nowhere, which
 * would silently destroy conserved resources.
 */
export const ownershipReferencesResolve: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11J Unauthorised transfers cannot bypass ownership validation.";
  const exists = (id: string): boolean =>
    state.inhabitants[id] !== undefined || state.organisations[id] !== undefined;

  for (const s of sortedValues(state.structures)) {
    if (s.owner !== null && state.inhabitants[s.owner] === undefined) {
      out.push(
        violation("ownership_references_resolve", spec, s.id, `owner ${s.owner} does not exist`),
      );
    }
    if (s.ownerOrganisation !== null && state.organisations[s.ownerOrganisation] === undefined) {
      out.push(
        violation(
          "ownership_references_resolve",
          spec,
          s.id,
          `owning organisation ${s.ownerOrganisation} does not exist`,
        ),
      );
    }
    for (const occupant of [...s.occupants].sort()) {
      if (state.inhabitants[occupant] === undefined) {
        out.push(
          violation(
            "ownership_references_resolve",
            spec,
            s.id,
            `lists occupant ${occupant}, who does not exist`,
          ),
        );
      }
    }
  }
  for (const a of sortedValues(state.artifacts)) {
    if (a.owner !== null && state.inhabitants[a.owner] === undefined) {
      out.push(
        violation("ownership_references_resolve", spec, a.id, `owner ${a.owner} does not exist`),
      );
    }
    if (a.ownerOrganisation !== null && state.organisations[a.ownerOrganisation] === undefined) {
      out.push(
        violation(
          "ownership_references_resolve",
          spec,
          a.id,
          `owning organisation ${a.ownerOrganisation} does not exist`,
        ),
      );
    }
  }
  for (const c of sortedValues(state.contracts)) {
    for (const party of [...c.parties].sort()) {
      if (!exists(party)) {
        out.push(
          violation("ownership_references_resolve", spec, c.id, `party ${party} does not exist`),
        );
      }
    }
  }
  for (const o of sortedValues(state.organisations)) {
    for (const member of [...o.members].sort()) {
      if (state.inhabitants[member] === undefined) {
        out.push(
          violation("ownership_references_resolve", spec, o.id, `member ${member} does not exist`),
        );
      }
    }
  }
  for (const c of sortedValues(state.conditions)) {
    if (state.inhabitants[c.subject] === undefined) {
      out.push(
        violation("ownership_references_resolve", spec, c.id, `subject ${c.subject} does not exist`),
      );
    }
  }
  for (const i of sortedValues(state.inhabitants)) {
    for (const membership of [...i.memberships].sort()) {
      const org = state.organisations[membership];
      if (org === undefined) {
        out.push(
          violation(
            "ownership_references_resolve",
            spec,
            i.id,
            `claims membership of ${membership}, which does not exist`,
          ),
        );
      } else if (!org.members.includes(i.id)) {
        out.push(
          violation(
            "ownership_references_resolve",
            spec,
            i.id,
            `claims membership of ${membership}, which does not list them`,
          ),
        );
      }
    }
    for (const contractId of [...i.contracts].sort()) {
      if (state.contracts[contractId] === undefined) {
        out.push(
          violation(
            "ownership_references_resolve",
            spec,
            i.id,
            `holds contract ${contractId}, which does not exist`,
          ),
        );
      }
    }
    for (const conditionId of [...i.conditions].sort()) {
      if (state.conditions[conditionId] === undefined) {
        out.push(
          violation(
            "ownership_references_resolve",
            spec,
            i.id,
            `has condition ${conditionId}, which does not exist`,
          ),
        );
      }
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* §5 — Physical placement.                                                   */
/* ------------------------------------------------------------------------- */

/**
 * §5: the world is a grid; §11A: every action has a location.
 *
 * Nobody stands off the map or in open water. A resolver that moved an
 * inhabitant onto water would otherwise leave them permanently unable to act,
 * since every move out is also blocked.
 */
export const entitiesOccupyValidTiles: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§5 Begin with a configurable two-dimensional grid.";
  for (const i of sortedValues(state.inhabitants)) {
    const terrain = terrainAt(state.map, i.location);
    if (terrain === null) {
      out.push(
        violation(
          "entities_occupy_valid_tiles",
          spec,
          i.id,
          `stands at (${i.location.x}, ${i.location.y}), which is off the map`,
        ),
      );
    } else if (terrain === "water") {
      out.push(
        violation(
          "entities_occupy_valid_tiles",
          spec,
          i.id,
          `stands on water at (${i.location.x}, ${i.location.y})`,
        ),
      );
    }
  }
  for (const s of sortedValues(state.structures)) {
    if (terrainAt(state.map, s.location) === null) {
      out.push(
        violation(
          "entities_occupy_valid_tiles",
          spec,
          s.id,
          `is at (${s.location.x}, ${s.location.y}), which is off the map`,
        ),
      );
    }
  }
  for (const key of sortedIds(state.deposits)) {
    const [xs, ys] = key.split(",");
    const coord = { x: Number(xs), y: Number(ys) };
    if (terrainAt(state.map, coord) === null) {
      out.push(
        violation("entities_occupy_valid_tiles", spec, key, "deposit lies off the map"),
      );
    }
  }
  return out;
};

/**
 * §11H: a confined inhabitant is "restricted from leaving a location".
 *
 * Physical confinement means physical co-location: the subject must actually be
 * standing at the structure that holds them. Without this, "confinement" would
 * be a status flag, which is exactly the deleted-turn implementation §11H bans.
 */
export const confinedInhabitantsAreAtTheirStructure: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11H A confined inhabitant may be restricted from leaving a location.";
  for (const c of sortedValues(state.confinements)) {
    if (c.released) continue;
    const subject = state.inhabitants[c.subject];
    const structure = state.structures[c.structureId];
    if (subject === undefined || structure === undefined) continue;
    if (chebyshevDistance(subject.location, structure.location) !== 0) {
      out.push(
        violation(
          "confined_inhabitants_are_at_their_structure",
          spec,
          c.subject,
          `is confined to structure ${c.structureId} at (${structure.location.x}, ` +
            `${structure.location.y}) but stands at (${subject.location.x}, ${subject.location.y})`,
        ),
      );
    }
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Needs and caps                                                             */
/* ------------------------------------------------------------------------- */

/**
 * §11B: "Every inhabitant has a daily capacity determined by available
 * simulated hours, required rest, health, developmental stage, energy..."
 *
 * Energy and needs must stay inside their declared bounds. An inhabitant with
 * energy above its cap has been given capacity from nowhere; one with a need
 * above the ceiling has an unbounded pressure that no action can ever relieve.
 */
export const needsAndCapsWithinBounds: Check = (state) => {
  const out: InvariantViolation[] = [];
  const spec = "§11B Every inhabitant has a daily capacity determined by ... energy.";
  const bound = (i: Inhabitant, label: string, value: number, max: number): void => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      out.push(
        violation(
          "needs_and_caps_within_bounds",
          spec,
          i.id,
          `${label} is ${String(value)}, outside 0..${max}`,
        ),
      );
    }
  };
  for (const i of sortedValues(state.inhabitants)) {
    bound(i, "needs.hunger", i.needs.hunger, 100);
    bound(i, "needs.thirst", i.needs.thirst, 100);
    bound(i, "needs.fatigue", i.needs.fatigue, 100);
    bound(i, "needs.social", i.needs.social, 100);
    bound(i, "energy", i.inventory.energy ?? 0, i.maxEnergy);
    bound(i, "compute", i.inventory.compute ?? 0, i.maxCompute);
  }
  return out;
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */

/** Every check, in a fixed order so violation lists are reproducible. */
export const INVARIANT_CHECKS: readonly (readonly [string, Check])[] = Object.freeze([
  ["no_negative_balances", noNegativeBalances],
  ["conserved_resource_totals", conservedResourceTotals],
  ["single_primary_activity", singlePrimaryActivity],
  ["activities_consume_participant_time", activitiesConsumeParticipantTime],
  ["care_consumes_time_and_resources", careConsumesTimeAndResources],
  ["sequence_monotonic", sequenceMonotonic],
  ["sim_time_non_decreasing", simTimeNonDecreasing],
  ["dead_inhabitants_cannot_act", deadInhabitantsCannotAct],
  ["population_ceiling", populationCeiling],
  ["descendants_require_creation_events", descendantsRequireCreationEvents],
  ["exposed_is_backed_by_inventory", exposedIsBackedByInventory],
  ["currency_ledgers_balance", currencyLedgersBalance],
  ["world_rules_unchanged", worldRulesUnchanged],
  [
    "claimed_authority_requires_membership_or_confinement",
    claimedAuthorityRequiresMembershipOrConfinement,
  ],
  ["confinement_grounds_are_neutral", confinementGroundsAreNeutral],
  ["confinement_consumes_confiners_resources", confinementConsumesConfinersResources],
  ["confined_inhabitants_remain_intact", confinedInhabitantsRemainIntact],
  ["confined_inhabitants_are_at_their_structure", confinedInhabitantsAreAtTheirStructure],
  ["memories_are_append_only_and_owned", memoriesAreAppendOnlyAndOwned],
  ["ownership_references_resolve", ownershipReferencesResolve],
  ["entities_occupy_valid_tiles", entitiesOccupyValidTiles],
  ["needs_and_caps_within_bounds", needsAndCapsWithinBounds],
] as const);

/**
 * Run every invariant.
 *
 * Returns a list rather than throwing, in a fixed order. An empty list is the
 * only acceptable result for a canonical world; the turn pipeline refuses to
 * commit an event whose post-state produces violations.
 */
export function checkInvariants(state: WorldState): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const [, check] of INVARIANT_CHECKS) {
    try {
      out.push(...check(state));
    } catch (error) {
      /* c8 ignore next 9 */
      out.push(
        violation(
          "invariant_check_failed",
          "§15 Implement automated enforcement and tests.",
          null,
          `an invariant check itself threw: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return out;
}

/** Convenience for tests: a single readable line per violation. */
export function formatViolations(violations: readonly InvariantViolation[]): string {
  return violations
    .map((v) => `${v.invariant}${v.subject === null ? "" : ` [${v.subject}]`}: ${v.detail}`)
    .join("\n");
}
