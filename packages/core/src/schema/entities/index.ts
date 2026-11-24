// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Materialised world entities (§4E, §6, §8, §10, §11, §12, §19).
 *
 * These schemas describe the *cache*, not the truth. The append-only event log
 * is the world (§4D); everything here can be thrown away and rebuilt by replay,
 * and §15 requires that doing so produce an identical checksum. Treat any
 * temptation to store something here that cannot be derived from the log as a
 * bug in the making.
 */
export * from "./common.js";
export * from "./skills.js";
export * from "./condition.js";
export * from "./memory.js";
export * from "./inhabitant.js";
export * from "./structure.js";
export * from "./artifact.js";
export * from "./organisation.js";
export * from "./contract.js";
export * from "./currency.js";
