/**
 * Tests for the materialised entity schemas.
 *
 * These prove the properties that are easy to erode by accident: that §6's
 * field list is complete, that §9's prohibition on assigned careers is
 * structural, that a reflection can never be mistaken for a fact (§19), and
 * that every entity survives canonical encoding so replay can checksum it
 * (§15, §16).
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../util/canonical.js";
import * as entities from "./index.js";
import { ContractSchema } from "./contract.js";
import { CurrencySchema } from "./currency.js";
import { InhabitantSchema } from "./inhabitant.js";
import { EpisodicMemorySchema, MemorySchema, ReflectionMemorySchema } from "./memory.js";
import { SKILL_NAMES, SkillNameSchema } from "./skills.js";

/** A newly created inhabitant with only the fields the schema insists on. */
const MINIMAL_INHABITANT = {
  id: "inh_founder",
  worldId: "world_1",
  displayName: "Founder",
  generation: 0,
  creationEventSequence: 0,
  birthTime: 0,
  location: { x: 16, y: 16 },
  activity: { state: "idle", startedAt: 0, endsAt: 0 },
  needs: {},
  property: {},
  energy: { current: 100, max: 100 },
  computeAllowance: { perDay: 1000, remainingToday: 1000, dayStartedAt: 0 },
  maturity: { stage: 3 },
  reputation: {},
  health: {},
  modelConfig: { modelId: "gemini-2.5-flash-lite" },
  nextEligibleAt: 0,
};

describe("InhabitantSchema (§6)", () => {
  it("parses a minimal founder and fills every absent field deterministically", () => {
    const founder = InhabitantSchema.parse(MINIMAL_INHABITANT);
    expect(founder.status).toBe("active");
    expect(founder.deathEvent).toBeNull();
    expect(founder.parentIds).toEqual([]);
    expect(founder.skills).toEqual({});
  });

  it("carries every field §6 requires, with nothing omitted", () => {
    const founder = InhabitantSchema.parse(MINIMAL_INHABITANT);
    const required = [
      "id", // stable unique identifier
      "displayName", // display name
      "generation", // generation number
      "parentIds", // parent or creator identifiers
      "creationEventSequence", // creation event
      "birthTime", // birth time
      "location", // current location
      "status", // status
      "personalityTraits", // personality traits
      "values", // values
      "privateGoals", // private goals
      "needs", // current needs
      "inventory", // inventory
      "property", // property
      "energy", // energy
      "computeAllowance", // compute allowance
      "skills", // learned skills
      "relationships", // relationships
      "reputation", // reputation
      "groupMemberships", // group memberships
      "contractIds", // contracts and obligations
      "obligations",
      "episodicMemoryIds", // episodic memories
      "reflectionMemoryIds", // long-term memory summaries
      "beliefsAboutOthers", // beliefs about other inhabitants
      "knownLocations", // known locations
      "knownPublicInformation", // known public information
      "health", // health and integrity state
      "voice", // voice identity
      "modelConfig", // model configuration
      "lastActionAt", // last action time
      "nextEligibleAt", // next eligible action time
      "deathEvent", // death event, when applicable
      // §11A / §11B additions
      "activity",
      "maturity",
      "confinementId",
    ];
    for (const field of required) {
      expect(Object.keys(founder), `§6 requires ${field}`).toContain(field);
    }
  });

  it("permits exactly one primary activity, structurally (§11A, §11J)", () => {
    const founder = InhabitantSchema.parse(MINIMAL_INHABITANT);
    // One object, never a list. A second concurrent activity is not
    // representable, so it cannot be a bug the engine has to catch.
    expect(Array.isArray(founder.activity)).toBe(false);
    expect(founder.activity.state).toBe("idle");
  });

  it("keeps a dead inhabitant's whole record intact (§8)", () => {
    const dead = InhabitantSchema.parse({
      ...MINIMAL_INHABITANT,
      status: "dead",
      values: ["build something that lasts"],
      relationships: {
        inh_b: { otherId: "inh_b", trust: 40, kind: "colleague" },
      },
      deathEvent: { diedAt: 5000, eventSequence: 412, cause: "starvation" },
    });
    // Death marks inactive; it deletes nothing.
    expect(dead.status).toBe("dead");
    expect(dead.values).toEqual(["build something that lasts"]);
    expect(dead.relationships["inh_b"]?.trust).toBe(40);
    expect(dead.deathEvent?.cause).toBe("starvation");
  });

  it("keeps every numeric field an integer, so state can be checksummed", () => {
    const founder = InhabitantSchema.parse(MINIMAL_INHABITANT);
    expect(() => canonicalJson(founder)).not.toThrow();

    // A float anywhere makes the record unhashable, so the schema must refuse it.
    expect(
      InhabitantSchema.safeParse({ ...MINIMAL_INHABITANT, energy: { current: 99.5, max: 100 } })
        .success,
    ).toBe(false);
    expect(
      InhabitantSchema.safeParse({ ...MINIMAL_INHABITANT, location: { x: 16.5, y: 16 } }).success,
    ).toBe(false);
    // Model temperature is thousandths, not a float.
    expect(
      InhabitantSchema.safeParse({
        ...MINIMAL_INHABITANT,
        modelConfig: { modelId: "m", temperatureMilli: 0.7 },
      }).success,
    ).toBe(false);
  });
});

describe("skills (§9)", () => {
  it("defines the fifteen skills §9 names, in order", () => {
    expect(SKILL_NAMES).toEqual([
      "gathering",
      "construction",
      "crafting",
      "communication",
      "negotiation",
      "organisation",
      "teaching",
      "diagnosis",
      "treatment",
      "writing",
      "performance",
      "visual_creation",
      "research",
      "accounting",
      "leadership",
    ]);
  });

  it("rejects a career or profession as a skill name", () => {
    for (const notASkill of ["doctor", "writer", "politician", "merchant", "guard", "auditor"]) {
      expect(SkillNameSchema.safeParse(notASkill).success).toBe(false);
    }
  });

  it("exports no career, profession or role enum anywhere in the entity layer (§9)", () => {
    // §9: "Do not define rigid careers such as doctor, writer, politician or
    // merchant." Careers are labels inferred from behaviour at read time; if one
    // is ever stored, this fails.
    const forbidden = /^(Career|Profession|Job|Vocation|Occupation)/;
    const offenders = Object.keys(entities).filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
  });

  it("stores skill level and practice as integers", () => {
    const parsed = InhabitantSchema.parse({
      ...MINIMAL_INHABITANT,
      skills: {
        gathering: { level: 12, practice: 4800, taughtMinutes: 120, lastPractisedAt: 4000 },
      },
    });
    expect(parsed.skills.gathering?.level).toBe(12);
    expect(() => canonicalJson(parsed)).not.toThrow();
  });
});

describe("memory (§19)", () => {
  const episodic = {
    kind: "episodic" as const,
    id: "mem_1",
    worldId: "world_1",
    ownerId: "inh_founder",
    createdAt: 100,
    occurredAt: 90,
    summary: "The eastern store was empty at dawn.",
    provenance: "observed" as const,
  };

  const reflection = {
    kind: "reflection" as const,
    id: "mem_2",
    worldId: "world_1",
    ownerId: "inh_founder",
    createdAt: 200,
    coversFrom: 0,
    coversTo: 200,
    statement: "Agent B cannot be relied on to keep a store.",
    isBelief: true as const,
  };

  it("discriminates the two durable levels", () => {
    expect(MemorySchema.parse(episodic).kind).toBe("episodic");
    expect(MemorySchema.parse(reflection).kind).toBe("reflection");
  });

  it("marks a reflection as a belief and refuses to let it claim otherwise", () => {
    // §19: "Reflections are beliefs, not canonical facts." The literal `true`
    // means no code path can produce a reflection that reads as a fact.
    expect(ReflectionMemorySchema.parse(reflection).isBelief).toBe(true);
    expect(ReflectionMemorySchema.safeParse({ ...reflection, isBelief: false }).success).toBe(false);
  });

  it("records provenance, so private information can be traced to a disclosure (§15)", () => {
    const heard = EpisodicMemorySchema.parse({
      ...episodic,
      provenance: "told",
      sourceInhabitantId: "inh_b",
    });
    expect(heard.provenance).toBe("told");
    expect(heard.sourceInhabitantId).toBe("inh_b");
  });

  it("supersedes rather than rewrites (§19)", () => {
    const revised = EpisodicMemorySchema.parse({ ...episodic, supersededByMemoryId: "mem_9" });
    // The original text is untouched; the correction lives in a new record.
    expect(revised.summary).toBe(episodic.summary);
    expect(revised.supersededByMemoryId).toBe("mem_9");
  });
});

describe("currency and contracts (§10, §11G)", () => {
  const currency = {
    id: "cur_1",
    worldId: "world_1",
    issuer: { kind: "inhabitant" as const, id: "inh_founder" },
    createdAt: 1000,
    createdByEventSequence: 42,
    name: "Ridge Mark",
    symbol: "RM",
    supplyRule: "fixed" as const,
    transferRule: "free" as const,
    governance: "issuer" as const,
  };

  it("carries every field §10 requires of a currency", () => {
    const parsed = CurrencySchema.parse(currency);
    for (const field of [
      "issuer",
      "name",
      "symbol",
      "supplyRule",
      "ledger",
      "transferRule",
      "backing",
      "governance",
      "description",
    ]) {
      expect(Object.keys(parsed)).toContain(field);
    }
  });

  it("grants a currency no authority whatsoever (§11G)", () => {
    const parsed = CurrencySchema.parse(currency);
    // "Creating a currency does not automatically create a government."
    for (const forbidden of ["legalTender", "jurisdiction", "authority", "mandatoryAcceptance"]) {
      expect(Object.keys(parsed)).not.toContain(forbidden);
    }
  });

  it("refuses a negative ledger balance (§15)", () => {
    expect(
      CurrencySchema.safeParse({ ...currency, ledger: { inh_b: -50 } }).success,
    ).toBe(false);
    expect(CurrencySchema.safeParse({ ...currency, ledger: { inh_b: 1.5 } }).success).toBe(false);
    expect(CurrencySchema.parse({ ...currency, ledger: { inh_b: 50 } }).ledger["inh_b"]).toBe(50);
  });

  it("keeps promised and delivered separate, so partial performance is a real state", () => {
    const contract = ContractSchema.parse({
      id: "con_1",
      worldId: "world_1",
      kind: "employment",
      title: "Woodcutting",
      parties: [{ holder: { kind: "inhabitant", id: "inh_founder" } }],
      obligations: [
        {
          index: 0,
          obligorIndex: 0,
          description: "Ten wood by the fourth day.",
          promisedResources: { wood: 10 },
          deliveredResources: { wood: 9 },
        },
      ],
      offeredById: "inh_founder",
      offeredAt: 100,
      offeredByEventSequence: 7,
    });
    const obligation = contract.obligations[0];
    expect(obligation?.promisedResources.wood).toBe(10);
    expect(obligation?.deliveredResources.wood).toBe(9);
    // Neither performed nor breached until the deadline decides.
    expect(obligation?.status).toBe("pending");
    expect(() => canonicalJson(contract)).not.toThrow();
  });
});
