/**
 * Branded identifiers.
 *
 * Every id in the world is a string, which means TypeScript would happily let an
 * `OrganisationId` be passed where an `InhabitantId` is expected. Branding makes
 * those mistakes compile errors instead of corrupt world state.
 *
 * Ids are *derived*, never randomly generated at runtime: an id is a function of
 * the event that created the entity. This is what makes replay reproduce
 * byte-identical state — a `crypto.randomUUID()` would differ on every run.
 */
import { HashDomain, hashValue } from "./util/hash.js";

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

export type WorldId = Branded<string, "WorldId">;
export type InhabitantId = Branded<string, "InhabitantId">;
export type EventId = Branded<string, "EventId">;
export type StructureId = Branded<string, "StructureId">;
export type ArtifactId = Branded<string, "ArtifactId">;
export type OrganisationId = Branded<string, "OrganisationId">;
export type ContractId = Branded<string, "ContractId">;
export type CurrencyId = Branded<string, "CurrencyId">;
export type MemoryId = Branded<string, "MemoryId">;
export type ConditionId = Branded<string, "ConditionId">;
export type TreatmentId = Branded<string, "TreatmentId">;
export type ActivityId = Branded<string, "ActivityId">;
export type ConfinementId = Branded<string, "ConfinementId">;

/** Prefixes make ids self-describing in logs and the audit export. */
const PREFIX = {
  inhabitant: "inh",
  structure: "str",
  artifact: "art",
  organisation: "org",
  contract: "con",
  currency: "cur",
  memory: "mem",
  condition: "cnd",
  treatment: "trt",
  activity: "act",
  confinement: "cnf",
} as const;

type EntityKind = keyof typeof PREFIX;

/**
 * Derive an entity id deterministically from the creating event.
 *
 * `sequence` is the canonical event sequence number and `discriminator`
 * separates multiple entities created by a single event (e.g. two artifacts from
 * one action). The same inputs always produce the same id, on every replay.
 */
export function deriveId(
  kind: EntityKind,
  worldId: string,
  sequence: number,
  discriminator = 0,
): string {
  const digest = hashValue(HashDomain.Event, {
    kind,
    worldId,
    sequence,
    discriminator,
  });
  return `${PREFIX[kind]}_${digest.slice(0, 24)}`;
}

export const deriveInhabitantId = (w: string, seq: number, d = 0) =>
  deriveId("inhabitant", w, seq, d) as InhabitantId;
export const deriveStructureId = (w: string, seq: number, d = 0) =>
  deriveId("structure", w, seq, d) as StructureId;
export const deriveArtifactId = (w: string, seq: number, d = 0) =>
  deriveId("artifact", w, seq, d) as ArtifactId;
export const deriveOrganisationId = (w: string, seq: number, d = 0) =>
  deriveId("organisation", w, seq, d) as OrganisationId;
export const deriveContractId = (w: string, seq: number, d = 0) =>
  deriveId("contract", w, seq, d) as ContractId;
export const deriveCurrencyId = (w: string, seq: number, d = 0) =>
  deriveId("currency", w, seq, d) as CurrencyId;
export const deriveMemoryId = (w: string, seq: number, d = 0) =>
  deriveId("memory", w, seq, d) as MemoryId;
export const deriveConditionId = (w: string, seq: number, d = 0) =>
  deriveId("condition", w, seq, d) as ConditionId;
export const deriveActivityId = (w: string, seq: number, d = 0) =>
  deriveId("activity", w, seq, d) as ActivityId;
export const deriveConfinementId = (w: string, seq: number, d = 0) =>
  deriveId("confinement", w, seq, d) as ConfinementId;

/** An event id is simply the world id and sequence number: unique by construction. */
export function makeEventId(worldId: WorldId, sequence: number): EventId {
  return `${worldId}#${sequence}` as EventId;
}
