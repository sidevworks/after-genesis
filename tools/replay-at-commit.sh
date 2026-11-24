#!/usr/bin/env bash
# Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
# SPDX-License-Identifier: Apache-2.0
#
# Replay one recorded run against the engine as it was at a given commit.
#
# The July 2026 runs were recorded while the engine was still changing (their
# provenance says "local-uncommitted"). World rules changed afterwards, so the
# current engine cannot regenerate their state; the engine of the day can.
# This extracts packages/core + packages/audit at <commit> into a temp folder and
# runs tools/verify-runs.ts there. Read-only on the run data.
#
# Usage: tools/replay-at-commit.sh <run-dir> <commit> [<commit> ...]
#   Prints "<commit> replay-ok" for the first commit whose engine reproduces
#   every pre/post state checksum, or "<commit> <first mismatch>" for each miss.
# Needs: npm ci at the repo root (for tsx and zod).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$(cd "$1" && pwd)"; shift
NM="$REPO/node_modules"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for c in "$@"; do
  T="$TMP/$c"; mkdir -p "$T/node_modules/@after-genesis" "$T/tools" "$T/one"
  if ! git -C "$REPO" archive "$c" packages/core packages/audit tsconfig.base.json 2>/dev/null | tar -x -C "$T" 2>/dev/null; then
    echo "$c no-audit-package"; continue
  fi
  echo '{"type":"module"}' > "$T/package.json"
  ln -s "$T/packages/core" "$T/node_modules/@after-genesis/core"
  ln -s "$T/packages/audit" "$T/node_modules/@after-genesis/audit"
  for x in "$NM"/*; do n="$(basename "$x")"; [ "$n" = "@after-genesis" ] || ln -s "$x" "$T/node_modules/$n"; done
  cp "$REPO/tools/verify-runs.ts" "$T/tools/"
  ln -s "$RUN" "$T/one/$(basename "$RUN")"
  res="$(cd "$T" && node --import=tsx tools/verify-runs.ts one | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s)[0].replay;console.log(r.ok?"replay-ok":JSON.stringify(r.firstMismatch??r.error).slice(0,160))})')"
  echo "$c $res"
  [ "$res" = "replay-ok" ] && exit 0
done
exit 1
