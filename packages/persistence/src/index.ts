/**
 * `@after-genesis/persistence` — implementations of the storage ports.
 *
 * Everything here sits behind an interface declared in `@after-genesis/core`.
 * The engine never imports this package; the composition root wires an
 * implementation in. That is what lets the same engine run against memory in a
 * unit test, against files in the CLI and the public verifier, and against
 * Firestore in production, with no code path in the simulation aware of which.
 *
 * Note what this package does not export: no update, no delete, no repair. A
 * corrupt log is reported, never fixed.
 */
export * from "./errors.js";
export * from "./clock.js";
export * from "./memory-event-store.js";
export * from "./file-event-store.js";
export * from "./state-store.js";
export * from "./memory-idempotency-store.js";
export * from "./file-model-audit-store.js";
