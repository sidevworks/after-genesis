/**
 * The deterministic world engine (§4A).
 *
 * "The LLM proposes intentions. The deterministic world engine decides
 * reality." Everything exported here is pure: given the same state, action,
 * time and sequence, it returns byte-identical results forever. No clock, no
 * network, no filesystem, no `Math.random`, no floating point.
 */
export * from "./state.js";
export * from "./voice.js";
export * from "./health.js";
export * from "./checksum.js";
export * from "./mapgen.js";
export * from "./invariants.js";
export * from "./observation.js";
export * from "./resolvers/index.js";
