// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * The media service (§4G, §21).
 *
 * Converts stored canonical dialogue and derived captions into audio. It is
 * read-only with respect to the world: nothing exported here can propose,
 * validate or commit a canonical write, and §15 requires that "Media services
 * cannot mutate world state".
 */
export * from "./voice-registry.js";
export * from "./elevenlabs.js";
export * from "./manifest.js";
export * from "./render.js";
export * from "./narration-style.js";
export * from "./narration-cache.js";
