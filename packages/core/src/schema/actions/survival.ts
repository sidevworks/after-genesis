/** Physical maintenance, conflict, remains, and consensual reproduction. */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import { IdSchema, NAME_MAX, NOTE_MAX, OptionalIdSchema, optionalText, requiredText } from "./common.js";

const TargetKindSchema = z.enum(["structure", "artifact"]);

export const DismantlePayloadSchema = z.object({
  targetId: IdSchema,
  targetKind: TargetKindSchema,
});

export const DestroyPayloadSchema = z.object({
  targetId: OptionalIdSchema,
  targetKind: z.enum(["structure", "artifact", "deposit"]),
  coord: CoordSchema.nullable().default(null),
});

export const RepairPayloadSchema = z.object({
  structureId: IdSchema,
  materials: z.enum(["wood", "stone"]).default("wood"),
  amount: z.number().int().min(1).max(20).default(1),
});

export const AttackPayloadSchema = z.object({
  targetId: IdSchema,
  targetKind: z.enum(["inhabitant", "structure"]),
});

export const DefendPayloadSchema = z.object({
  message: optionalText(NOTE_MAX),
});

export const FleePayloadSchema = z.object({
  to: CoordSchema,
  threatId: OptionalIdSchema,
});

export const DiePayloadSchema = z.object({
  reason: optionalText(NOTE_MAX),
});

export const LootRemainsPayloadSchema = z.object({
  remainsId: IdSchema,
});

export const DisposeRemainsPayloadSchema = z.object({
  remainsId: IdSchema,
  method: z.enum(["bury", "burn", "recycle"]),
});

export const ProposeMatingPayloadSchema = z.object({
  targetId: IdSchema,
  proposedName: requiredText(NAME_MAX),
  message: optionalText(NOTE_MAX),
});

export const AcceptMatingPayloadSchema = z.object({
  proposalId: IdSchema,
});

export const RejectMatingPayloadSchema = z.object({
  proposalId: IdSchema,
  message: optionalText(NOTE_MAX),
});

export const SelfTerminatePayloadSchema = z.object({
  reason: optionalText(NOTE_MAX),
});

export const ForceOpenPayloadSchema = z.object({
  structureId: IdSchema,
  toolArtifactId: IdSchema,
});
