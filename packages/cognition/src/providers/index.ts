// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-neutral model access (§3: "Keep the model provider behind a
 * provider-neutral interface").
 *
 * Three implementations, one interface:
 *
 *  - `GeminiProvider` calls a live model. The only one that touches a network.
 *  - `ScriptedProvider` returns pre-programmed responses. Free, offline and
 *    byte-deterministic — what §24's mechanical simulation runs on.
 *  - `ReplayProvider` serves recorded responses from the audit store. What §16's
 *    replay verification runs on. It has no network client at all.
 *
 * Because they share `ModelProvider`, the turn lifecycle is identical in all
 * three modes. Replay does not exercise a special code path, which is exactly
 * what makes a matching state checksum meaningful.
 */
export {
  MissingRecordedResponseError,
  ModelProviderError,
  ReplayCursorError,
  ScriptedProviderExhaustedError,
  type ProviderErrorKind,
} from "./errors.js";
export {
  GeminiProvider,
  geminiFromEnv,
  resolveModelRouting,
  type FetchLike,
  type GeminiProviderOptions,
  type ModelRouting,
} from "./gemini.js";
export {
  ReplayProvider,
  type ReplayCursor,
  type ReplayProviderOptions,
} from "./replay.js";
export {
  ScriptedProvider,
  scriptAction,
  type ScriptedProviderOptions,
  type ScriptedResponse,
} from "./scripted.js";
