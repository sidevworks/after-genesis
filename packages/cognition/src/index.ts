/**
 * @after-genesis/cognition — the cognition service (§4B).
 *
 * The boundary this package defends is stated in §2: "The LLM proposes
 * intentions. The deterministic world engine decides reality."
 *
 * Everything exported here builds a prompt, calls a model, and returns a
 * validated proposal. Nothing exported here can write state, grant a capability,
 * or let model text influence anything except which action is proposed. That is
 * not a convention — it is visible in the types: there is no store, no
 * transaction, no mutation method anywhere in this surface, and the richest
 * thing a caller can get back is a `ProposedAction` the engine is free to
 * reject.
 *
 * Read `untrusted.ts` first. Inhabitants author text that other inhabitants
 * read, which makes every prompt this package builds a document containing
 * hostile input from the reader's point of view.
 */
export { proposeAction } from "./cognition.js";
export type {
  CognitionAttempt,
  CognitionDeps,
  CognitionInput,
  CognitionResult,
} from "./cognition.js";

export {
  SpendLedger,
  UnknownModelPriceError,
  assertSealedWorldPolicy,
  usdToMicros,
  type PriceTable,
  type SpendEnforcement,
  type SpendEntry,
  type SpendLimits,
  type SpendSnapshot,
} from "./budget.js";

export {
  beliefHistory,
  createReflection,
  estimateTokens,
  isBelief,
  isObservedMemory,
  maturityScalePercent,
  recencyScore,
  retrievalBudget,
  retrieveMemories,
  reviseReflection,
  scoreMemory,
  weightsFor,
  type EpisodicMemory,
  type MemoryRecord,
  type Reflection,
  type ReflectionDraft,
  type RetrievalBudget,
  type RetrievalContext,
  type RetrievalResult,
  type ScoreBreakdown,
  type ScoredMemory,
  type ScoreWeights,
  type WorkingMemory,
} from "./memory.js";

export {
  MAX_PAYLOAD_CHARS,
  MAX_PAYLOAD_DEPTH,
  MAX_RESPONSE_CHARS,
  extractJsonObject,
  hashRawResponse,
  parseModelResponse,
  type ParseFailure,
  type ParseFailureCode,
  type ParseResult,
  type ParseSuccess,
} from "./parse.js";
export {
  NEUTRAL_CAPABILITIES,
  NEUTRAL_RESPONSE_JSON_SCHEMA,
  NeutralModelResponseSchema,
  collectBasisIds,
  parseNeutralModelResponse,
  translateNeutralResponse,
  type NeutralCapability,
  type NeutralModelResponse,
} from "./neutral-protocol.js";

export {
  IMMUTABLE_INHABITANT_PROTOCOL,
  PROMPT_CONSTITUTION_HASH,
  PROMPT_VERSION,
  RESPONSE_JSON_SCHEMA,
  buildCorrectionRequest,
  buildPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  hashRequest,
  type BuiltPrompt,
  type PromptInput,
  type PromptOptions,
} from "./prompt.js";

export {
  DEFAULT_MAX_BLOCK_CHARS,
  UNTRUSTED_DELIMITERS,
  UNTRUSTED_POLICY,
  countDelimiters,
  renderUntrustedBlock,
  sanitiseUntrusted,
  type SanitisationFlag,
  type SanitisedText,
  type UntrustedBlock,
  type UntrustedBlockMeta,
} from "./untrusted.js";

export type {
  AuthoredText,
  AvailableAction,
  HealthCondition,
  HeldValue,
  Maturity,
  Need,
  Observation,
  PerceivedInhabitant,
  PerceivedStructure,
  PerceivedTile,
  Point,
  PrivateGoal,
  SelfView,
  Skill,
  Trait,
} from "./types.js";

export * from "./providers/index.js";
