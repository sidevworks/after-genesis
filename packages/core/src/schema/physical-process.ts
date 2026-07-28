/**
 * Canonical choreography for actions that change the physical world.
 *
 * The process is stored in an action's resolution. It does not invent extra
 * actions or simulation outcomes: it divides the already-resolved duration and
 * material movement into deterministic, replayable stages. Renderers may add
 * cosmetic interpolation, but these stages are the authoritative order,
 * targets and progress boundaries.
 */
import { z } from "zod";
import { CoordSchema, ResourceBundleSchema, type Coord, type ResourceBundle } from "./primitives.js";

export const PhysicalProcessStageKindSchema = z.enum([
  "approach",
  "prepare",
  "work",
  "transfer_assemble",
  "complete",
]);
export type PhysicalProcessStageKind = z.infer<typeof PhysicalProcessStageKindSchema>;

export const PhysicalInteractionSchema = z.enum([
  "travel_to_target",
  "ready_materials",
  "manipulate_target",
  "transfer_or_assemble",
  "inspect_result",
]);

export const PhysicalProcessTargetSchema = z.object({
  kind: z.enum(["tile", "resource_source", "structure", "artifact", "inventory"]),
  id: z.string().min(1).nullable(),
  coord: CoordSchema,
  label: z.string().min(1).max(160),
});
export type PhysicalProcessTarget = z.infer<typeof PhysicalProcessTargetSchema>;

export const PhysicalProcessStageSchema = z.object({
  kind: PhysicalProcessStageKindSchema,
  interaction: PhysicalInteractionSchema,
  startMinute: z.number().int().nonnegative(),
  endMinute: z.number().int().nonnegative(),
  progressFrom: z.number().int().min(0).max(100),
  progressTo: z.number().int().min(0).max(100),
});
export type PhysicalProcessStage = z.infer<typeof PhysicalProcessStageSchema>;

export const PhysicalProcessSchema = z.object({
  version: z.literal(1),
  /** Existing action vocabulary, copied verbatim rather than expanded. */
  actionType: z.string().min(1),
  actorIds: z.array(z.string().min(1)).min(1),
  origin: CoordSchema,
  target: PhysicalProcessTargetSchema,
  toolIds: z.array(z.string().min(1)),
  /** Resources removed from a holder/source by the resolved action. */
  materials: ResourceBundleSchema,
  /** Resources placed into a holder by the resolved action. */
  output: ResourceBundleSchema,
  resultEntityIds: z.array(z.string().min(1)),
  durationMinutes: z.number().int().positive(),
  stages: z.tuple([
    PhysicalProcessStageSchema,
    PhysicalProcessStageSchema,
    PhysicalProcessStageSchema,
    PhysicalProcessStageSchema,
    PhysicalProcessStageSchema,
  ]),
});
export type PhysicalProcess = z.infer<typeof PhysicalProcessSchema>;

const STAGE_DEFINITIONS = [
  ["approach", "travel_to_target", 0, 10],
  ["prepare", "ready_materials", 10, 20],
  ["work", "manipulate_target", 20, 70],
  ["transfer_assemble", "transfer_or_assemble", 70, 95],
  ["complete", "inspect_result", 95, 100],
] as const;

export interface PhysicalProcessInput {
  readonly actionType: string;
  readonly actorIds: readonly string[];
  readonly origin: Coord;
  readonly target: PhysicalProcessTarget;
  readonly durationMinutes: number;
  readonly toolIds?: readonly string[];
  readonly materials?: ResourceBundle;
  readonly output?: ResourceBundle;
  readonly resultEntityIds?: readonly string[];
}

/**
 * Produce the same process for the same resolved facts, without randomness or
 * wall-clock input. Integer boundaries ensure replay is stable on every host.
 */
export function derivePhysicalProcess(input: PhysicalProcessInput): PhysicalProcess {
  const stages = STAGE_DEFINITIONS.map(([kind, interaction, from, to]) => ({
    kind,
    interaction,
    startMinute: Math.floor((input.durationMinutes * from) / 100),
    endMinute: Math.floor((input.durationMinutes * to) / 100),
    progressFrom: from,
    progressTo: to,
  })) as PhysicalProcess["stages"];

  return {
    version: 1,
    actionType: input.actionType,
    actorIds: [...input.actorIds],
    origin: { ...input.origin },
    target: { ...input.target, coord: { ...input.target.coord } },
    toolIds: [...(input.toolIds ?? [])],
    materials: { ...(input.materials ?? {}) },
    output: { ...(input.output ?? {}) },
    resultEntityIds: [...(input.resultEntityIds ?? [])],
    durationMinutes: input.durationMinutes,
    stages,
  };
}
