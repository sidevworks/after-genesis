import { z } from "zod";
import {
  IdSchema,
  MAX_TERM_MINUTES,
  NAME_MAX,
  STATEMENT_MAX,
  minutesInRange,
  optionalText,
} from "./common.js";

/** Copy symbolic content. Copying neither endorses nor validates it. */
export const CopyArtifactPayloadSchema = z.object({
  sourceArtifactId: IdSchema,
  title: z.string().min(1).max(NAME_MAX).optional(),
});

/** Physically place a nearby body inside an existing enclosure. */
export const RestrainPayloadSchema = z.object({
  targetId: IdSchema,
  structureId: IdSchema,
  durationMinutes: minutesInRange(1, MAX_TERM_MINUTES),
  message: optionalText(STATEMENT_MAX),
});

/** Physically end an active restraint. This makes no judgement about it. */
export const ReleasePayloadSchema = z.object({
  targetId: IdSchema,
  message: optionalText(STATEMENT_MAX),
});
