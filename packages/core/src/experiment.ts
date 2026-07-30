/**
 * Public experiment identity.
 *
 * A world is not a sealed experiment merely because its event chain verifies.
 * Fixtures, development rehearsals and invalidated runs may all have perfectly
 * valid hashes. This manifest states what kind of record is being produced and
 * freezes the human-controlled inputs before sequence zero.
 */
import { z } from "zod";
import { HashDomain, hashValue, type Sha256Hex } from "./util/hash.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const RunClassificationSchema = z.enum([
  "sealed_experiment",
  "development_run",
  "invalidated_run",
  "scripted_fixture",
]);
export type RunClassification = z.infer<typeof RunClassificationSchema>;

export const GenesisManifestSchema = z.object({
  manifestVersion: z.literal(1),
  worldId: z.string().min(1),
  classification: RunClassificationSchema,
  constitution: z.object({
    systemPromptTemplateHash: Sha256Schema,
    worldRulesHash: Sha256Schema,
    actionSchemaHash: Sha256Schema,
    initialStateHash: Sha256Schema,
    sourceCommit: z.string().min(1),
    deployedDigest: z.string().min(1),
  }),
  cognition: z.object({
    modelIds: z.array(z.string().min(1)).min(1),
    parametersHash: Sha256Schema,
    memoryPolicyHash: Sha256Schema,
    retryPolicyHash: Sha256Schema,
  }),
  genesis: z.object({
    randomSeed: z.string().min(1),
    initialPopulation: z.number().int().min(1),
  }),
  evaluationCriteriaHash: Sha256Schema,
  /** Human-readable criteria are published, but never enter inhabitant context. */
  evaluationCriteria: z.array(z.string().min(1)).min(1),
  interventionPolicy: z.object({
    humanMessagesAfterGenesis: z.literal(false),
    manualRetries: z.literal(false),
    rescues: z.literal(false),
    promptChanges: z.literal(false),
    stateCorrections: z.literal(false),
    selectiveDeletion: z.literal(false),
    addedResources: z.literal(false),
    spectatorWriteRoute: z.literal(false),
  }),
});
export type GenesisManifest = z.infer<typeof GenesisManifestSchema>;

export interface BuildGenesisManifestInput {
  readonly worldId: string;
  readonly classification: RunClassification;
  readonly systemPromptTemplateHash: Sha256Hex;
  readonly worldRulesHash: Sha256Hex;
  readonly actionSchemaHash: Sha256Hex;
  readonly initialStateHash: Sha256Hex;
  readonly sourceCommit: string;
  readonly deployedDigest: string;
  readonly modelIds: readonly string[];
  readonly parametersHash: Sha256Hex;
  readonly memoryPolicyHash: Sha256Hex;
  readonly retryPolicyHash: Sha256Hex;
  readonly randomSeed: string;
  readonly initialPopulation: number;
  readonly evaluationCriteria: readonly string[];
}

export function buildGenesisManifest(input: BuildGenesisManifestInput): GenesisManifest {
  const evaluationCriteria = [...input.evaluationCriteria];
  return GenesisManifestSchema.parse({
    manifestVersion: 1,
    worldId: input.worldId,
    classification: input.classification,
    constitution: {
      systemPromptTemplateHash: input.systemPromptTemplateHash,
      worldRulesHash: input.worldRulesHash,
      actionSchemaHash: input.actionSchemaHash,
      initialStateHash: input.initialStateHash,
      sourceCommit: input.sourceCommit,
      deployedDigest: input.deployedDigest,
    },
    cognition: {
      modelIds: [...new Set(input.modelIds)].sort(),
      parametersHash: input.parametersHash,
      memoryPolicyHash: input.memoryPolicyHash,
      retryPolicyHash: input.retryPolicyHash,
    },
    genesis: {
      randomSeed: input.randomSeed,
      initialPopulation: input.initialPopulation,
    },
    evaluationCriteriaHash: hashValue(HashDomain.GenesisManifest, {
      kind: "evaluation-criteria",
      values: evaluationCriteria,
    }),
    evaluationCriteria,
    interventionPolicy: {
      humanMessagesAfterGenesis: false,
      manualRetries: false,
      rescues: false,
      promptChanges: false,
      stateCorrections: false,
      selectiveDeletion: false,
      addedResources: false,
      spectatorWriteRoute: false,
    },
  });
}

export function hashGenesisManifest(manifest: GenesisManifest): Sha256Hex {
  return hashValue(HashDomain.GenesisManifest, GenesisManifestSchema.parse(manifest));
}

/**
 * A sealed label is a falsifiable claim. Reject missing placeholders and any
 * manifest whose public world identity disagrees with the world it labels.
 */
export function assertSealedManifest(manifest: GenesisManifest, worldId: string): void {
  const parsed = GenesisManifestSchema.parse(manifest);
  if (parsed.classification !== "sealed_experiment") {
    throw new Error(`manifest is ${parsed.classification}, not sealed_experiment`);
  }
  if (parsed.worldId !== worldId) {
    throw new Error(`manifest world ${parsed.worldId} does not match ${worldId}`);
  }
  for (const value of [
    parsed.constitution.sourceCommit,
    parsed.constitution.deployedDigest,
  ]) {
    if (["local", "local-uncommitted", "unknown"].includes(value)) {
      throw new Error("sealed experiments require an immutable commit and deployed digest");
    }
  }
}
