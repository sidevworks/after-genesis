// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Read-only: verify the hash chain and deterministically replay every event log
 * found under a folder of run directories (<root>/<run>/events/*.jsonl).
 *
 * Usage: node --import=tsx tools/verify-runs.ts <runs-root> > verification.json
 *
 * Uses the same verifier (`verifyExport`) and replay (`replayHistory`) as
 * `npm run verify` and `npm run world -- replay`. It writes nothing to the runs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalEventSchema } from "@after-genesis/core";
import { replayHistory, verifyExport } from "@after-genesis/audit";

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write("usage: verify-runs.ts <runs-root>\n");
    process.exitCode = 2;
    return;
  }
  const out: Record<string, unknown>[] = [];
  for (const run of (await readdir(root)).sort()) {
    const eventsDir = join(root, run, "events");
    if (!(await stat(eventsDir).catch(() => null))?.isDirectory()) continue;
    for (const f of (await readdir(eventsDir)).filter((n) => n.endsWith(".jsonl")).sort()) {
      const raw = (await readFile(join(eventsDir, f), "utf8"))
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as unknown);
      const v = verifyExport(raw, { requireGenesis: true }) as unknown as {
        ok: boolean;
        headHash?: string;
        violations?: unknown[];
      };
      const parsed = raw.map((e) => CanonicalEventSchema.safeParse(e));
      let replay: { ok: boolean; finalChecksum: string | null; mismatches: number; firstMismatch: unknown } | { error: string };
      if (parsed.every((p) => p.success)) {
        try {
          const r = replayHistory(parsed.map((p) => p.data!));
          replay = { ok: r.ok, finalChecksum: r.finalChecksum, mismatches: r.mismatches.length, firstMismatch: r.mismatches[0] ?? null };
        } catch (err) {
          replay = { error: String(err).slice(0, 300) };
        }
      } else {
        replay = { error: "schema parse failed for some events" };
      }
      out.push({
        run,
        file: f,
        events: raw.length,
        chainOk: v.ok,
        headHash: v.headHash ?? null,
        violations: (v.violations ?? []).length,
        firstViolation: (v.violations ?? [])[0] ?? null,
        replay,
      });
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

await main();
