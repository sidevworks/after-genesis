// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Mapping a world id onto a file name.
 *
 * World ids are opaque strings. Writing one straight into a path would let an id
 * containing `/` or `..` escape the store's directory, so ids are constrained to
 * a conservative character set and anything outside it is replaced and
 * disambiguated with a digest. The digest guarantees two different ids can never
 * collide onto one file, which would silently merge two worlds' histories.
 */
import { sha256Hex } from "@after-genesis/core";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A file-system-safe stem derived from a world id, injectively. */
export function worldFileStem(worldId: string): string {
  if (worldId.length === 0) throw new RangeError("worldId must not be empty");
  if (SAFE.test(worldId) && !worldId.includes("..")) return worldId;
  const sanitised = worldId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "world";
  return `${sanitised}__${sha256Hex(worldId).slice(0, 16)}`;
}
